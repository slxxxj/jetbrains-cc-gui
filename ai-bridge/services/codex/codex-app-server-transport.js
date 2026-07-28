/**
 * Codex App Server transport -- real token-level streaming.
 *
 * The legacy transport (@openai/codex-sdk -> `codex exec --experimental-json`)
 * only emits `item.completed` events: the full agent_message / reasoning text
 * arrives in a single event, so the UI renders responses in one big chunk.
 *
 * This transport spawns `codex app-server` instead and speaks its newline-
 * delimited JSON-RPC protocol over stdio. The app server emits true delta
 * notifications (`item/agentMessage/delta`, `item/reasoning/textDelta`,
 * `item/reasoning/summaryTextDelta`) which this module converts into the
 * exec-style event shapes ({type:'item.updated', item:{... cumulative ...}})
 * consumed by processCodexEventStream -- so the entire downstream pipeline
 * (Java handlers, webview rendering) works unchanged.
 *
 * Approval handling also changes: instead of the bridge preemptively asking
 * Java when it sees an item.started (racy -- the command may already have
 * run), the app server pauses and waits for our JSON-RPC response before
 * executing. Server approval requests are mapped onto the same Java
 * permission bridge (requestPermissionFromJava).
 *
 * Env escape hatch: CODEAIDE_CODEX_TRANSPORT=exec forces the legacy SDK path.
 */

import { spawn } from 'child_process';
import readline from 'readline';
import { AsyncStream } from '../../utils/async-stream.js';
import { requestPermissionFromJava } from '../../permission-handler.js';
import { resolveCodexBinary } from '../model-list-service.js';
import {
  smartToolName, smartDescription, mapCommandToolNameToPermissionToolName
} from './codex-command-utils.js';
import { logInfo, logWarn, logDebug } from './codex-utils.js';

const CLIENT_NAME = 'codeaide-ai-bridge';
const CLIENT_TITLE = 'CodeAide AI Bridge';
const CLIENT_VERSION = '1.0.0';

// AskForApproval values accepted by the app-server protocol (v2).
const APP_SERVER_APPROVAL_POLICIES = new Set(['untrusted', 'on-request', 'never']);

// ---------------------------------------------------------------------------
// TOML config override serialization (mirrors @openai/codex-sdk dist)
// ---------------------------------------------------------------------------

function toTomlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return `${value}`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(toTomlValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    const parts = Object.entries(value).map(([key, entry]) => `${key} = ${toTomlValue(entry)}`);
    return `{ ${parts.join(', ')} }`;
  }
  throw new Error('Unsupported config override value type');
}

function flattenConfigOverrides(value, prefix, overrides) {
  const isPlainObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isPlainObject) {
    if (prefix) {
      overrides.push(`${prefix}=${toTomlValue(value)}`);
      return;
    }
    throw new Error('Codex config overrides must be a plain object');
  }
  for (const [key, entry] of Object.entries(value)) {
    flattenConfigOverrides(entry, prefix ? `${prefix}.${key}` : key, overrides);
  }
}

function serializeConfigOverrides(config) {
  const overrides = [];
  flattenConfigOverrides(config, '', overrides);
  return overrides;
}

// ---------------------------------------------------------------------------
// JSON-RPC client over stdio (newline-delimited JSON)
// ---------------------------------------------------------------------------

class AppServerClient {
  constructor(proc) {
    this.proc = proc;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.notificationHandler = null;
    this.serverRequestHandler = null;
    this.exited = false;

    this.lineReader = readline.createInterface({ input: proc.stdout });
    this.lineReader.on('line', (line) => this.handleLine(line));

    proc.on('error', (error) => this.handleExit(error));
    proc.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        this.handleExit(new Error(`codex app-server exited with code ${code}`));
      } else if (signal) {
        this.handleExit(new Error(`codex app-server terminated by signal ${signal}`));
      } else {
        this.handleExit(new Error('codex app-server exited'));
      }
    });
  }

  handleExit(error) {
    if (this.exited) return;
    this.exited = true;
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
    if (this.notificationHandler) {
      this.notificationHandler({ method: '__exit__', params: { message: error.message } });
    }
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      logDebug('APP_SERVER', 'Ignoring non-JSON line from app-server:', trimmed.substring(0, 200));
      return;
    }

    const hasMethod = typeof message.method === 'string';
    const hasId = message.id !== undefined && message.id !== null;

    if (hasMethod && hasId) {
      // Server -> client request (approvals, tool calls, ...)
      if (this.serverRequestHandler) {
        Promise.resolve(this.serverRequestHandler(message)).catch((error) => {
          logWarn('APP_SERVER', `Server request handler failed for ${message.method}: ${error?.message || error}`);
          this.respondError(message.id, -32603, error?.message || String(error));
        });
      } else {
        this.respondError(message.id, -32601, 'Client does not handle server requests');
      }
      return;
    }

    if (hasMethod) {
      if (this.notificationHandler) this.notificationHandler(message);
      return;
    }

    if (hasId) {
      const pendingEntry = this.pending.get(message.id);
      if (!pendingEntry) return;
      this.pending.delete(message.id);
      if (message.error) {
        const errorMessage = message.error.message || JSON.stringify(message.error);
        pendingEntry.reject(new Error(`app-server ${pendingEntry.method} failed: ${errorMessage}`));
      } else {
        pendingEntry.resolve(message.result);
      }
    }
  }

  write(payload) {
    if (!this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  request(method, params) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.write({ method, id, params });
    });
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  respondError(id, code, message) {
    this.write({ id, error: { code, message } });
  }

  close() {
    this.notificationHandler = null;
    this.serverRequestHandler = null;
    try { this.lineReader.close(); } catch { /* noop */ }
    try { this.proc.stdin.end(); } catch { /* noop */ }
    try { this.proc.kill(); } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// ThreadItem (camelCase, app-server) -> exec-style item (snake_case) mapping
// ---------------------------------------------------------------------------

function translateThreadItem(item) {
  if (!item || typeof item !== 'object') return null;
  switch (item.type) {
  case 'agentMessage':
    return { id: item.id, type: 'agent_message', text: item.text || '' };
  case 'reasoning': {
    const parts = [];
    if (Array.isArray(item.summary)) parts.push(...item.summary);
    if (Array.isArray(item.content)) parts.push(...item.content);
    return { id: item.id, type: 'reasoning', text: parts.filter(Boolean).join('\n') };
  }
  case 'commandExecution':
    return {
      id: item.id,
      type: 'command_execution',
      command: typeof item.command === 'string' ? item.command : '',
      aggregated_output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '',
      exit_code: typeof item.exitCode === 'number' ? item.exitCode : null,
      status: item.status || 'completed',
      is_error: item.status === 'failed' || item.status === 'declined'
    };
  case 'fileChange':
    return {
      id: item.id,
      type: 'file_change',
      changes: Array.isArray(item.changes) ? item.changes : [],
      status: item.status || 'completed'
    };
  case 'mcpToolCall':
    return {
      id: item.id,
      type: 'mcp_tool_call',
      server: item.server || '',
      tool: item.tool || '',
      arguments: item.arguments ?? {},
      status: item.status === 'failed' ? 'failed' : 'completed',
      result: item.result
        ? { content: item.result.content, structured_content: item.result.structuredContent }
        : null,
      error: item.error || null
    };
  default:
    // userMessage / plan / webSearch / collab* / ... have no exec equivalent.
    return null;
  }
}

function toUserInputs(input) {
  const items = Array.isArray(input) ? input : [{ type: 'text', text: String(input) }];
  const userInputs = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      userInputs.push({ type: 'text', text: item.text, text_elements: [] });
    } else if (item.type === 'local_image' && typeof item.path === 'string') {
      userInputs.push({ type: 'localImage', path: item.path });
    }
  }
  return userInputs;
}

function toExecUsage(lastBreakdown) {
  if (!lastBreakdown || typeof lastBreakdown !== 'object') return null;
  return {
    input_tokens: lastBreakdown.inputTokens || 0,
    cached_input_tokens: lastBreakdown.cachedInputTokens || 0,
    output_tokens: lastBreakdown.outputTokens || 0
  };
}

// ---------------------------------------------------------------------------
// Approval requests -> Java permission bridge
// ---------------------------------------------------------------------------

function normalizeApprovalCommand(rawCommand) {
  if (typeof rawCommand === 'string') return rawCommand;
  if (Array.isArray(rawCommand)) return rawCommand.join(' ');
  return '';
}

async function decideViaJavaBridge(toolName, input) {
  try {
    logInfo('PERM_DEBUG', `app-server approval request: tool=${toolName}`);
    const allowed = await requestPermissionFromJava(toolName, input);
    logInfo('PERM_DEBUG', `app-server approval decision: tool=${toolName}, allowed=${allowed ? 'true' : 'false'}`);
    return !!allowed;
  } catch (error) {
    logWarn('PERM_DEBUG', `app-server approval bridge failed, deny by default: ${error?.message || error}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// startAppServerStream
// ---------------------------------------------------------------------------

/**
 * Spawn `codex app-server`, start/resume a thread and start a turn.
 *
 * @param {Object} options
 * @param {Array|string} options.input - exec-style input ({type:'text'} / {type:'local_image'})
 * @param {string|null} options.threadId - thread to resume, or null for a new thread
 * @param {Object} options.threadOptions - { model, modelReasoningEffort, approvalPolicy, sandboxMode, workingDirectory }
 * @param {string|null} options.baseUrl
 * @param {string|null} options.apiKey
 * @param {string|null} options.serviceTier
 * @param {Object} options.cliEnv - sanitized environment for the CLI process
 * @param {Function} [options.onCommandApprovalDenied] - called when the user
 *   denies a command approval (mirrors the legacy abort semantics so the
 *   event handler suppresses the resulting interrupted-turn error)
 * @returns {Promise<{events: AsyncIterable, abort: Function, threadId: string}>}
 */
export async function startAppServerStream(options) {
  const {
    input,
    threadId = null,
    threadOptions = {},
    baseUrl = null,
    apiKey = null,
    serviceTier = null,
    cliEnv = null,
    onCommandApprovalDenied = null
  } = options;

  const binary = resolveCodexBinary();
  if (!binary) {
    throw new Error('Codex CLI binary not found (required for app-server transport)');
  }

  // ---- Spawn ---------------------------------------------------------------

  const args = ['app-server'];
  const configOverrides = { model_supports_reasoning_summaries: true };
  if (serviceTier && serviceTier.trim() !== '') {
    configOverrides.features = { fast_mode: true };
    configOverrides.service_tier = serviceTier.trim();
  }
  for (const override of serializeConfigOverrides(configOverrides)) {
    args.push('--config', override);
  }
  if (baseUrl) {
    args.push('--config', `openai_base_url=${toTomlValue(baseUrl)}`);
  }

  const env = { ...(cliEnv || process.env) };
  if (apiKey) {
    env.CODEX_API_KEY = apiKey;
  }

  logInfo('APP_SERVER', `Spawning: ${binary} ${args.join(' ')}`);
  const proc = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

  const stderrLines = [];
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      stderrLines.push(line);
      if (stderrLines.length > 50) stderrLines.shift();
      logDebug('APP_SERVER', '[stderr]', line);
    }
  });

  const client = new AppServerClient(proc);
  const stream = new AsyncStream();

  // ---- Stream state ----------------------------------------------------------

  const agentTextByItemId = new Map();
  const reasoningTextByItemId = new Map();
  let lastUsage = null;
  let activeTurnId = null;
  let turnFinished = false;
  let closed = false;

  const failStream = (error) => {
    if (turnFinished || closed) return;
    turnFinished = true;
    stream.enqueue({ type: 'turn.failed', error: { message: error?.message || String(error) } });
    stream.done();
    client.close();
  };

  const finishStream = () => {
    if (closed) return;
    closed = true;
    stream.done();
    client.close();
  };

  // ---- Server requests (approvals) -------------------------------------------

  client.serverRequestHandler = async (message) => {
    const { method, id, params = {} } = message;
    switch (method) {
    case 'item/commandExecution/requestApproval': {
      const command = normalizeApprovalCommand(params.command);
      const toolName = mapCommandToolNameToPermissionToolName(smartToolName(command));
      const description = smartDescription(command);
      const allowed = await decideViaJavaBridge(toolName, {
        command,
        description,
        source: 'codex_command_execution',
        reason: params.reason || undefined
      });
      if (allowed) {
        client.respond(id, { decision: 'accept' });
      } else {
        // Mirror the legacy semantics: a denied command aborts the turn.
        if (typeof onCommandApprovalDenied === 'function') onCommandApprovalDenied();
        client.respond(id, { decision: 'cancel' });
      }
      return;
    }
    case 'execCommandApproval': {
      const command = normalizeApprovalCommand(params.command);
      const toolName = mapCommandToolNameToPermissionToolName(smartToolName(command));
      const description = smartDescription(command);
      const allowed = await decideViaJavaBridge(toolName, {
        command,
        description,
        source: 'codex_command_execution',
        reason: params.reason || undefined
      });
      if (allowed) {
        client.respond(id, { decision: 'approved' });
      } else {
        if (typeof onCommandApprovalDenied === 'function') onCommandApprovalDenied();
        client.respond(id, { decision: 'abort' });
      }
      return;
    }
    case 'item/fileChange/requestApproval': {
      const allowed = await decideViaJavaBridge('Edit', {
        file_path: params.grantRoot || '',
        reason: params.reason || '',
        source: 'codex_file_change'
      });
      client.respond(id, { decision: allowed ? 'accept' : 'decline' });
      return;
    }
    case 'applyPatchApproval': {
      const fileChanges = params.fileChanges && typeof params.fileChanges === 'object'
        ? Object.keys(params.fileChanges)
        : [];
      const allowed = await decideViaJavaBridge('Edit', {
        file_path: params.grantRoot || fileChanges[0] || '',
        reason: params.reason || '',
        source: 'codex_file_change'
      });
      client.respond(id, allowed
        ? { decision: 'approved' }
        : { decision: { denied: { rejection: 'Change denied by user' } } });
      return;
    }
    default:
      // item/tool/call, item/tool/requestUserInput, item/permissions/requestApproval,
      // mcpServer/elicitation/request, account/chatgptAuthTokens/refresh, ...
      logWarn('APP_SERVER', `Unsupported server request ${method}; responding with error`);
      client.respondError(id, -32601, `Unsupported server request: ${method}`);
    }
  };

  // ---- Notifications -> exec-style events --------------------------------------

  client.notificationHandler = (message) => {
    const { method, params = {} } = message;
    switch (method) {
    case '__exit__':
      failStream(new Error(params.message || 'codex app-server exited unexpectedly'));
      return;
    case 'thread/started':
      // Already synthesized from the thread/start|resume response.
      return;
    case 'turn/started':
      activeTurnId = params.turn?.id || activeTurnId;
      stream.enqueue({ type: 'turn.started' });
      return;
    case 'thread/tokenUsage/updated':
      lastUsage = toExecUsage(params.tokenUsage?.last);
      return;
    case 'item/started': {
      const translated = translateThreadItem(params.item);
      if (translated) stream.enqueue({ type: 'item.started', item: translated });
      return;
    }
    case 'item/agentMessage/delta': {
      const itemId = params.itemId || 'agent_message';
      const cumulative = (agentTextByItemId.get(itemId) || '') + (params.delta || '');
      agentTextByItemId.set(itemId, cumulative);
      stream.enqueue({ type: 'item.updated', item: { id: itemId, type: 'agent_message', text: cumulative } });
      return;
    }
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const itemId = params.itemId || 'reasoning';
      const cumulative = (reasoningTextByItemId.get(itemId) || '') + (params.delta || '');
      reasoningTextByItemId.set(itemId, cumulative);
      // __deltaOnly: the handler streams the thinking delta without emitting
      // a full thinking snapshot per update (snapshots only on completion).
      stream.enqueue({
        type: 'item.updated',
        item: { id: itemId, type: 'reasoning', text: cumulative },
        __deltaOnly: true
      });
      return;
    }
    case 'item/completed': {
      const translated = translateThreadItem(params.item);
      if (!translated) return;
      if (translated.type === 'agent_message') agentTextByItemId.delete(translated.id);
      if (translated.type === 'reasoning') reasoningTextByItemId.delete(translated.id);
      stream.enqueue({ type: 'item.completed', item: translated });
      return;
    }
    case 'turn/completed': {
      if (turnFinished) return;
      turnFinished = true;
      const turn = params.turn || {};
      if (turn.status === 'failed' || turn.status === 'interrupted') {
        const messageText = turn.error?.message
          || (turn.status === 'interrupted' ? 'Turn interrupted (aborted)' : 'Turn failed');
        stream.enqueue({ type: 'turn.failed', error: { message: messageText } });
      } else {
        stream.enqueue({ type: 'turn.completed', usage: lastUsage || {} });
      }
      finishStream();
      return;
    }
    case 'error':
      // Mid-turn errors are surfaced through the subsequent turn/completed
      // notification with status failed; only log here.
      logWarn('APP_SERVER', `error notification (willRetry=${params.willRetry}): ${params.error?.message || 'unknown'}`);
      return;
    default:
      return;
    }
  };

  // ---- Handshake + thread + turn -----------------------------------------------

  try {
    await client.request('initialize', {
      clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: CLIENT_VERSION },
      capabilities: null
    });
    client.notify('initialized');

    const approvalPolicy = APP_SERVER_APPROVAL_POLICIES.has(threadOptions.approvalPolicy)
      ? threadOptions.approvalPolicy
      : null;
    const threadParams = {
      model: threadOptions.model || null,
      approvalPolicy,
      sandbox: threadOptions.sandboxMode || null,
      serviceTier: serviceTier && serviceTier.trim() !== '' ? serviceTier.trim() : null
    };

    let resolvedThreadId;
    if (threadId && threadId.trim() !== '') {
      // Resume: skip cwd override (matches the legacy behavior of letting the
      // session lookup resolve the working directory).
      const response = await client.request('thread/resume', { ...threadParams, threadId });
      resolvedThreadId = response.thread.id;
    } else {
      if (threadOptions.workingDirectory) {
        threadParams.cwd = threadOptions.workingDirectory;
      }
      const response = await client.request('thread/start', threadParams);
      resolvedThreadId = response.thread.id;
    }

    // Synthesize the exec-style thread.started event so the event handler
    // initializes session bookkeeping exactly like the legacy transport.
    stream.enqueue({ type: 'thread.started', thread_id: resolvedThreadId });

    const turnParams = { threadId: resolvedThreadId, input: toUserInputs(input) };
    if (threadOptions.modelReasoningEffort) {
      turnParams.effort = threadOptions.modelReasoningEffort;
    }
    const turnResponse = await client.request('turn/start', turnParams);
    activeTurnId = turnResponse.turn?.id || null;

    const abort = async () => {
      try {
        if (activeTurnId && !turnFinished) {
          await client.request('turn/interrupt', { threadId: resolvedThreadId, turnId: activeTurnId });
        }
      } catch (error) {
        logDebug('APP_SERVER', `turn/interrupt failed: ${error?.message || error}`);
      } finally {
        finishStream();
      }
    };

    return { events: stream, abort, threadId: resolvedThreadId };
  } catch (error) {
    const stderrTail = stderrLines.slice(-5).join('\n');
    client.close();
    if (stderrTail) {
      throw new Error(`${error?.message || error}\napp-server stderr (tail): ${stderrTail}`);
    }
    throw error;
  }
}

/**
 * Transport selection: app-server by default (real streaming), `exec` as an
 * escape hatch via CODEAIDE_CODEX_TRANSPORT=exec.
 */
export function resolveCodexTransport() {
  const preference = (process.env.CODEAIDE_CODEX_TRANSPORT || 'app-server').trim().toLowerCase();
  return preference === 'exec' ? 'exec' : 'app-server';
}
