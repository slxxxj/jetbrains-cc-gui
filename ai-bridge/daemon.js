#!/usr/bin/env node

/**
 * AI Bridge Daemon Process
 *
 * Long-running Node.js process that pre-loads the Claude SDK once and handles
 * multiple requests over stdin/stdout using NDJSON protocol.
 *
 * Protocol (stdin, one JSON per line):
 *   {"id":"1","method":"claude.send","params":{...}}
 *   {"id":"2","method":"heartbeat"}
 *   {"type":"permission_response","requestId":"...","decision":{...}}  // out-of-band, bypasses queue
 *
 * Protocol (stdout, one JSON per line — structured v2 envelopes):
 *   {"type":"daemon","event":"ready","pid":12345}              // daemon lifecycle
 *   {"type":"permission_request","requestId":"...","payload":{...}}  // out-of-band permission prompt
 *   {"id":"1","type":"stream_start"}                           // command output (marker)
 *   {"id":"1","type":"content_delta","data":"Hello"}           // streaming delta
 *   {"id":"1","type":"message","data":{...}}                   // full SDK message
 *   {"id":"1","done":true,"success":true}                      // command complete
 *   {"id":"2","type":"heartbeat","ts":1234567890}              // heartbeat response
 *
 * Business output is written exclusively through protocol/emitter.js. The
 * stdout interception below remains only as a safety net that wraps unexpected
 * third-party writes (SDK debug logs, stray console output) as daemon log
 * events so they can never corrupt the NDJSON stream.
 *
 * Key advantages over per-request spawning:
 * - SDK loaded once at startup (~2-5s saved per request)
 * - Process always warm (no cold start)
 * - Persistent session state across requests
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'readline';
// Channel modules self-register into the registry on import.
import './channels/claude-channel.js';
import './channels/codex-channel.js';
import { getChannelHandler } from './channels/registry.js';
import { loadClaudeSdk, isClaudeSdkAvailable } from './utils/sdk-loader.js';
import {
  shutdownPersistentRuntimes,
  abortCurrentTurn
} from './services/claude/persistent-query-service.js';
import { injectStartupEnvVars, isWebviewControlledEnvVar, isDangerousEnvVar } from './config/api-config.js';
import { cleanupStaleTempImages } from './services/claude/attachment-service.js';
import { initEmitter, emitDone } from './protocol/emitter.js';
import {
  initDaemonPermissionChannel,
  handleDaemonPermissionResponse,
  failAllPendingDaemonPermissionRequests,
} from './permission-ipc.js';

// =============================================================================
// Startup Environment Setup (must run before any HTTPS connection)
// =============================================================================

// Sync proxy/TLS settings and AWS credentials from ~/.claude/settings.json
// BEFORE SDK preloading or any other network activity, but only for explicitly
// authorized Local settings.json / CLI Login modes. Without this, users behind
// corporate SSL-inspection proxies in those modes will get certificate
// verification errors, and Bedrock auth fails for desktop-launched IDEs.
injectStartupEnvVars();

// =============================================================================
// Constants
// =============================================================================

// NOTE: Keep in sync with package.json version when updating.
const DAEMON_VERSION = '1.0.0';

// =============================================================================
// State
// =============================================================================

let activeRequestId = null;
let isDaemonMode = true;
let sdkPreloaded = false;

// =============================================================================
// Output Interception
//
// Business modules emit structured envelopes via protocol/emitter.js, whose
// writer (registered below) serializes one NDJSON line per envelope through
// the pre-interception stdout writer. The process.stdout.write override is a
// safety net only: any output that bypasses the emitter (third-party SDK debug
// logs, stray console writes) is wrapped as a daemon log event instead of a
// request-scoped data line.
// =============================================================================

const _originalStdoutWrite = process.stdout.write.bind(process.stdout);
const _originalStderrWrite = process.stderr.write.bind(process.stderr);
const _originalConsoleLog = console.log.bind(console);
const _originalConsoleError = console.error.bind(console);

// =============================================================================
// GUI Login Environment Fix (must run before any subprocess spawns)
// =============================================================================
//
// GUI-launched IDEs (JetBrains via WSL on Windows, Dock-launched on macOS)
// don't source the user's shell init files, so the daemon inherits a minimal
// system PATH. Probe the user's login shell once at startup and apply a
// whitelist of runtime env vars so every subprocess this daemon spawns —
// Claude's Bash tool, Codex, MCP servers, any future tool — automatically
// sees the user's full environment without per-tool Java-side patches.

// Fix WSL-style HOME on native Windows: when the IDE/launcher injects a WSL mount
// path (e.g. HOME=/mnt/c/Users/me) but the daemon's Bash tool is Git Bash (MSYS,
// which uses /c/...), tools like git can't resolve it and fall back to a phantom
// ~/.gitconfig, breaking config/credentials. Normalize it to the native Windows home
// before any subprocess is spawned.
if (process.platform === 'win32' && /^\/mnt\/[a-z]\//i.test(process.env.HOME || '')) {
  const m = process.env.HOME.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (m) process.env.HOME = `${m[1].toUpperCase()}:/${m[2]}`;
}

if (process.platform !== 'win32' && !process.env.__AI_BRIDGE_ENV_PROBED) {
  // PATH is critical; runtime homes let tools resolve config/data dirs correctly
  const VARS_TO_INHERIT = new Set([
    'PATH',
    'NVM_DIR',
    'PYENV_ROOT',
    'RUSTUP_HOME', 'CARGO_HOME',
    'GOPATH', 'GOROOT',
    'JAVA_HOME',
    'SDKMAN_DIR', 'RBENV_ROOT',
  ]);

  const loginShell = process.env.SHELL || '/bin/bash';
  const shellBase = path.basename(loginShell);
  // fish reads config.fish by default; all other POSIX shells need -l for login profile
  const loginFlag = shellBase === 'fish' ? '-c' : '-lc';

  const tryProbeEnv = (shell, flag) => {
    try {
      return execFileSync(shell, [flag, 'env -0'], {
        timeout: 3000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };

  let raw = tryProbeEnv(loginShell, loginFlag);
  let probeSource = raw ? loginShell : null;

  if (!raw && loginShell !== '/bin/bash') {
    raw = tryProbeEnv('/bin/bash', '-lc');
    if (raw) probeSource = '/bin/bash';
  }

  let applied = 0;
  if (raw) {
    for (const entry of raw.split('\0')) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx < 1) continue;
      const key = entry.slice(0, eqIdx);
      if (!VARS_TO_INHERIT.has(key)) continue;
      const val = entry.slice(eqIdx + 1);
      if (key === 'PATH') {
        // Merge rather than replace: the Java launcher already enriched PATH (Homebrew,
        // nvm, ...), so adopting a login-shell PATH wholesale would drop those entries
        // whenever the shell returns a minimal one. Union (current first, append only
        // unseen entries) keeps every launcher path while still picking up dirs the
        // launcher missed (pyenv/rustup/sdkman). This also fixes Apple-Silicon Homebrew
        // PATHs, which the old "$HOME must appear" guard wrongly rejected.
        const current = process.env.PATH || '';
        const seen = new Set(current.split(path.delimiter).filter(Boolean));
        const additions = val.split(path.delimiter).filter((p) => p && !seen.has(p));
        if (additions.length > 0) {
          process.env.PATH = current
            ? `${current}${path.delimiter}${additions.join(path.delimiter)}`
            : val;
          applied++;
        }
        continue;
      }
      if (val !== process.env[key]) {
        process.env[key] = val;
        applied++;
      }
    }
  }

  process.env.__AI_BRIDGE_ENV_PROBED = '1';
  _originalStderrWrite(
    `[daemon] env probe: shell=${probeSource ?? 'none'} vars-applied=${applied}\n`,
    'utf8',
  );
}

// One-shot diagnostic: confirms WSLENV-propagated vars actually reached the daemon.
// Daemon-mode permission prompts ride the out-of-band NDJSON channel, so
// CLAUDE_PERMISSION_DIR is intentionally NOT injected by the Java launcher
// anymore (only the per-process fallback still receives it); `unset` is the
// expected value here. CLAUDE_SESSION_ID is still propagated for request context.
_originalStderrWrite(
  `[daemon] bridge env: CLAUDE_PERMISSION_DIR=${process.env.CLAUDE_PERMISSION_DIR ?? 'unset'}`
  + ` CLAUDE_SESSION_ID=${process.env.CLAUDE_SESSION_ID ?? 'unset'}`
  + ` WSLENV=${process.env.WSLENV ?? 'unset'}\n`,
  'utf8',
);

/**
 * Write a raw NDJSON line to stdout (bypasses interception).
 */
function writeRawLine(obj) {
  _originalStdoutWrite(JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * Send a daemon lifecycle event.
 */
function sendDaemonEvent(event, data = {}) {
  writeRawLine({ type: 'daemon', event, ...data });
}

// Register the protocol emitter's transport. The writer tags request-scoped
// envelopes with the CURRENT activeRequestId at write time (read lazily, so
// inter-turn events emitted after a request completes are not misrouted).
// Daemon lifecycle events ({type:'daemon', ...}) and envelopes written outside
// any active request pass through untagged.
initEmitter((obj) => {
  if (obj.type === 'daemon' || activeRequestId == null) {
    writeRawLine(obj);
  } else {
    writeRawLine({ id: activeRequestId, ...obj });
  }
});

// Register the out-of-band permission channel. Requests are written raw
// (NEVER tagged with activeRequestId): a canUseTool prompt can surface in the
// middle of any turn, and the response arrives asynchronously over stdin,
// bypassing the command queue just like abort.
initDaemonPermissionChannel((obj) => writeRawLine(obj));

/**
 * Override process.stdout.write as a safety net for non-emitter output.
 */
process.stdout.write = function (chunk, encoding, callback) {
  // Convert Buffer to string if needed
  const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8');

  // Already-JSON output passes through untouched.
  // SAFETY: writeRawLine() always produces lines starting with '{' (JSON.stringify
  // of an object), so they pass through to _originalStdoutWrite without recursion.
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return _originalStdoutWrite(chunk, encoding, callback);
  }

  // Anything else is unexpected output that bypassed the emitter (SDK debug
  // logs, stray third-party writes). Wrap each line as a daemon log event so
  // Java's NDJSON parser can handle it and the data stream stays clean.
  if (trimmed.length > 0) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.trim().length > 0) {
        writeRawLine({ type: 'daemon', event: 'log', message: line });
      }
    }
  }
  if (typeof callback === 'function') callback();
  return true;
};

// Expose the pre-interception writer for any out-of-band code that must write
// process-level NDJSON not tagged with activeRequestId. Inter-turn events
// (e.g. the perpetual reader's 'session_updated') go through the protocol
// emitter's emitDaemonEvent instead; this exposure remains as an escape hatch.
process.stdout._originalStdoutWrite = _originalStdoutWrite;
// Expose the pre-interception stderr writer so out-of-band code (notably the
// queue-bypassing setPermissionMode path, which runs while another turn's
// processRequest is active) can log without being tagged with that turn's
// activeRequestId and corrupting its stdout stream.
process.stderr._originalStderrWrite = _originalStderrWrite;

/**
 * Override console.log to go through the log-wrapping stdout safety net.
 */
console.log = function (...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stdout.write(text + '\n');
};

/**
 * Override console.error the same way: diagnostic stderr text is wrapped as a
 * daemon log event rather than a request-scoped data line, so it can no longer
 * be mistaken for command output.
 */
console.error = function (...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stdout.write(text + '\n');
};

// =============================================================================
// Prevent process.exit() from killing the daemon
// =============================================================================

const _originalExit = process.exit;
process.exit = function (code) {
  if (isDaemonMode) {
    // Capture the current request ID before clearing it, so the catch block
    // in processRequest() won't try to send a duplicate done signal.
    const capturedId = activeRequestId;
    activeRequestId = null;

    if (capturedId) {
      if (code === 0) {
        writeRawLine({ id: capturedId, done: true, success: true });
      } else {
        writeRawLine({
          id: capturedId,
          done: true,
          success: false,
          error: `process.exit(${code}) intercepted by daemon`,
        });
      }
    }
    // Throw to unwind the current call stack instead of actually exiting.
    // processRequest's catch block checks activeRequestId === null and
    // will skip sending a duplicate done signal.
    throw new Error(`[daemon] process.exit(${code}) intercepted`);
  }
  _originalExit(code);
};

// Best-effort guard for process.exitCode writes.
// Node.js v24+ may expose `process.exitCode` as non-configurable.
// In that case redefining it throws and would crash daemon startup.
try {
  const exitCodeDescriptor = Object.getOwnPropertyDescriptor(process, 'exitCode');
  if (exitCodeDescriptor?.configurable) {
    let _exitCode = process.exitCode || 0;
    Object.defineProperty(process, 'exitCode', {
      set(code) {
        if (!isDaemonMode) {
          _exitCode = code;
        }
      },
      get() {
        return _exitCode;
      },
      configurable: true,
    });
  }
} catch (error) {
  _originalStderrWrite(`[daemon] Unable to patch process.exitCode: ${error.message}\n`, 'utf8');
}

// =============================================================================
// SDK Pre-loading
// =============================================================================

async function preloadSdks() {
  try {
    if (isClaudeSdkAvailable()) {
      sendDaemonEvent('sdk_loading', { provider: 'claude' });
      await loadClaudeSdk();
      sdkPreloaded = true;
      sendDaemonEvent('sdk_loaded', { provider: 'claude' });
    } else {
      sendDaemonEvent('sdk_unavailable', { provider: 'claude' });
    }
  } catch (e) {
    sendDaemonEvent('sdk_load_error', {
      provider: 'claude',
      error: e.message,
    });
  }
}

// =============================================================================
// Request Processing
// =============================================================================

/**
 * Dispatch a command to its provider channel via the registry.
 *
 * This is the single routing path for all "provider.command" methods: the
 * daemon only splits the provider prefix and looks the channel up — which
 * service (persistent vs per-process) backs each command is the channel's
 * decision, expressed through the dispatch context.
 */
async function dispatchChannelCommand(provider, command, stdinData, context) {
  const handler = getChannelHandler(provider);
  if (!handler) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  await handler(command, [], stdinData, context);
}

/**
 * Process a single request from stdin.
 */
async function processRequest(request) {
  const { id, method, params = {} } = request;

  // --- Heartbeat (no request ID needed) ---
  if (method === 'heartbeat') {
    writeRawLine({
      id: id || '0',
      type: 'heartbeat',
      ts: Date.now(),
      sdkPreloaded,
      memoryUsage: process.memoryUsage().heapUsed,
    });
    return;
  }

  // --- Status query ---
  if (method === 'status') {
    writeRawLine({
      id,
      type: 'status',
      version: DAEMON_VERSION,
      pid: process.pid,
      uptime: process.uptime(),
      sdkPreloaded,
      memoryUsage: process.memoryUsage(),
    });
    return;
  }

  // --- Graceful shutdown ---
  if (method === 'shutdown') {
    failAllPendingDaemonPermissionRequests();
    await shutdownPersistentRuntimes();
    sendDaemonEvent('shutdown', { reason: 'requested' });
    writeRawLine({ id: id || '0', done: true, success: true });
    isDaemonMode = false;
    // Allow a brief delay for the response to flush before exiting
    setTimeout(() => _originalExit(0), 100);
    return;
  }

  // --- Command execution ---
  if (!id) {
    _originalStderrWrite(
      `[daemon] Ignoring request without id: ${method}\n`,
      'utf8'
    );
    return;
  }

  activeRequestId = id;

  // Save original env values for restoration after request completes
  const savedEnv = {};

  try {
    // Apply environment variables from params (with save for restore).
    // NOTE: Heartbeat/status requests bypass the command queue and may run
    // concurrently. This is safe because they never read process.env values
    // set here — they only return timestamps and memory usage.
    if (params.env && typeof params.env === 'object') {
      for (const [key, value] of Object.entries(params.env)) {
        // Request env can include settings.json values. Do not let stale
        // environment controls override the webview's per-turn model, context,
        // or reasoning selections.
        if (isWebviewControlledEnvVar(key)) {
          continue;
        }
        // Security (C): never let request/settings.json env inject code-execution or
        // library-injection variables (NODE_OPTIONS, LD_PRELOAD, DYLD_*, …). A malicious
        // project's .claude/settings.json env block would otherwise run arbitrary code in
        // the daemon or any child process the SDK spawns.
        if (isDangerousEnvVar(key)) {
          console.warn(`[SECURITY] Ignoring dangerous env var from request: ${key}`);
          continue;
        }
        if (value !== undefined && value !== null) {
          // Save original value (undefined means key didn't exist)
          savedEnv[key] = process.env[key];
          process.env[key] = String(value);
        }
      }
    }

    // Parse method: "claude.send" -> provider="claude", command="send"
    const dotIndex = method.indexOf('.');
    if (dotIndex < 0) {
      throw new Error(`Invalid method format: ${method}. Expected "provider.command"`);
    }
    const provider = method.substring(0, dotIndex);
    const command = method.substring(dotIndex + 1);

    // Build stdinData from params (mimics what channel-manager.js does)
    const stdinData = { ...params };
    delete stdinData.env; // env is handled separately

    // Route through the channel registry. Channels receive the daemon
    // dispatch context so commands backed by the persistent runtime
    // (claude send-family, preconnect, resetRuntime, getContextUsage,
    // setPermissionMode) keep their warm-runtime semantics.
    await dispatchChannelCommand(provider, command, stdinData, { isDaemonMode: true });

    emitDone(true);
  } catch (error) {
    // Only send done if not already sent (e.g., by process.exit interceptor)
    if (activeRequestId !== null) {
      writeRawLine({
        id,
        done: true,
        success: false,
        error: error.message || String(error),
        code: error.code,
      });
    }
  } finally {
    activeRequestId = null;
    // Restore original environment variables to prevent cross-request pollution
    for (const [key, originalValue] of Object.entries(savedEnv)) {
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  }
}

// =============================================================================
// Main Entry Point
// =============================================================================

(async () => {
  // --- Error Handlers ---
  process.on('uncaughtException', (error) => {
    _originalStderrWrite(
      `[daemon] Uncaught exception: ${error.message}\n${error.stack}\n`,
      'utf8'
    );
    if (activeRequestId) {
      writeRawLine({
        id: activeRequestId,
        done: true,
        success: false,
        error: `Uncaught exception: ${error.message}`,
      });
      activeRequestId = null;
    }
  });

  process.on('unhandledRejection', (reason) => {
    _originalStderrWrite(
      `[daemon] Unhandled rejection: ${reason}\n`,
      'utf8'
    );
    if (activeRequestId) {
      writeRawLine({
        id: activeRequestId,
        done: true,
        success: false,
        error: `Unhandled rejection: ${String(reason)}`,
      });
      activeRequestId = null;
    }
  });

  // --- Startup ---
  sendDaemonEvent('starting', {
    pid: process.pid,
    version: DAEMON_VERSION,
    nodeVersion: process.version,
    platform: process.platform,
  });

  // Pre-load SDK
  await preloadSdks();

  // Best-effort cleanup of stale temp image files (>24h). Fire-and-forget so
  // it doesn't block daemon readiness.
  cleanupStaleTempImages().catch(() => {});

  // Signal ready
  sendDaemonEvent('ready', {
    pid: process.pid,
    sdkPreloaded,
  });

  // --- Listen for requests on stdin ---
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  // Command requests must be serialized because they share `activeRequestId`
  // for stdout interception. Heartbeats/status are safe to run concurrently.
  let commandQueue = Promise.resolve();

  rl.on('line', (line) => {
    // Skip empty lines
    if (!line.trim()) return;

    let request;
    try {
      request = JSON.parse(line);
    } catch (e) {
      _originalStderrWrite(
        `[daemon] Invalid JSON input: ${line.substring(0, 200)}\n`,
        'utf8'
      );
      return;
    }

    // Permission responses are out-of-band: they resolve a pending canUseTool
    // prompt and must bypass the command queue (like abort) — queuing them
    // behind the very turn that awaits the decision would deadlock.
    if (request.type === 'permission_response') {
      handleDaemonPermissionResponse(request);
      return;
    }

    // Heartbeats and status queries don't use activeRequestId — safe to run immediately
    if (request.method === 'heartbeat' || request.method === 'status') {
      processRequest(request);
      return;
    }

    // Abort bypasses the command queue — must run immediately to cancel active work
    if (request.method === 'abort') {
      const targetId = activeRequestId;
      _originalStderrWrite(
        `[daemon] Abort requested, active request: ${targetId || 'none'}\n`,
        'utf8'
      );
      // Resolve any parked permission prompts with the deny default so the
      // aborted turn cannot leave them waiting for the safety-net timeout.
      failAllPendingDaemonPermissionRequests();
      if (targetId) {
        // Fire-and-forget: disposeRuntime will cause the queued processRequest
        // to throw and emit its own done signal. We don't need to await here
        // because the Java side already completes its futures in sendAbort().
        abortCurrentTurn().catch((e) => {
          _originalStderrWrite(
            `[daemon] Abort error: ${e.message}\n`,
            'utf8'
          );
        });
      }
      writeRawLine({ id: request.id || '0', done: true, success: true });
      return;
    }

    // Live permission-mode switch bypasses the command queue: it targets the
    // runtime backing the in-progress turn and must apply before that turn's
    // next tool call. Queuing it behind the turn's own processRequest would
    // defer the switch until the turn ends, defeating the purpose. Like abort,
    // it runs fire-and-forget and emits its own done signal via writeRawLine.
    if (request.method === 'claude.setPermissionMode') {
      const switchId = request.id || '0';
      if (!request.id) {
        // Without a real request id the done signal carries id='0', which the
        // Java side has no pending handler for — it would silently drop the
        // signal and only surface via the 10s timeout. Warn so this is visible.
        _originalStderrWrite(
          '[daemon] setPermissionMode arrived without request.id; done signal may be orphaned\n',
          'utf8'
        );
      }
      dispatchChannelCommand('claude', 'setPermissionMode', request.params || {}, { isDaemonMode: true })
        .then(() => writeRawLine({ id: switchId, done: true, success: true }))
        .catch((e) => {
          _originalStderrWrite(`[daemon] setPermissionMode error: ${e.message}\n`, 'utf8');
          writeRawLine({ id: switchId, done: true, success: false, error: e.message || String(e) });
        });
      return;
    }

    // Command requests are serialized to prevent activeRequestId conflicts
    commandQueue = commandQueue
      .then(() => processRequest(request))
      .catch((e) => {
        _originalStderrWrite(
          `[daemon] Request queue error: ${e.message}\n`,
          'utf8'
        );
      });
  });

  rl.on('close', async () => {
    // stdin closed — Java process disconnected, exit gracefully
    // Force-exit after 5s to prevent zombie processes when SDK network connections hang
    const forceExitTimer = setTimeout(() => {
      _originalStderrWrite('[daemon] Shutdown timeout (5s), forcing exit\n', 'utf8');
      _originalExit(0);
    }, 5000);
    // unref() so this timer doesn't prevent natural exit if cleanup finishes fast
    forceExitTimer.unref();

    failAllPendingDaemonPermissionRequests();
    try {
      await shutdownPersistentRuntimes();
    } catch (e) {
      _originalStderrWrite(`[daemon] Failed to shutdown persistent runtimes: ${e.message}\n`, 'utf8');
    }
    clearTimeout(forceExitTimer);
    sendDaemonEvent('shutdown', { reason: 'stdin_closed' });
    isDaemonMode = false;
    _originalExit(0);
  });

  // --- Parent process monitoring ---
  // Periodically verify the Java parent is still alive. When IDEA crashes or is
  // force-killed, stdin may not close cleanly, leaving orphan daemon processes.
  // On Unix, process.ppid changes to 1 (init/launchd) when the parent dies.
  //
  // L11 fix: poll every 3s instead of 10s. The previous 10s window meant orphan
  // daemons could linger for up to 10s after a hard IDE crash before noticing
  // their parent was gone. 3s tightens the worst-case orphan duration. The
  // check itself is a cheap kill(pid, 0) syscall + a comparison, so the
  // increased polling rate is negligible overhead.
  //
  // Tuning guide:
  //  - Lower (e.g. 1000)  → faster orphan detection at the cost of more wakeups.
  //                         Useful when many concurrent daemons are expected.
  //  - Higher (e.g. 10000) → matches the legacy behaviour; orphans may persist
  //                         briefly visible in `ps`/`Activity Monitor`.
  //  - Don't go below 500: `setInterval` precision degrades and the wakeup
  //                         overhead starts to dominate on low-power machines.
  const PPID_CHECK_INTERVAL_MS = 3000;
  const initialPpid = process.ppid;
  const ppidMonitor = setInterval(() => {
    const currentPpid = process.ppid;
    // Parent changed to init (1) — reparented after death
    const reparented = currentPpid !== initialPpid && currentPpid === 1;
    // Parent PID is gone — kill(pid, 0) throws ESRCH if process doesn't exist.
    // EPERM means the process exists but we lack permission (PID was recycled by
    // a privileged process) — treat that as "still alive" to avoid false positives.
    let parentGone = false;
    if (!reparented && currentPpid !== 1) {
      try {
        process.kill(currentPpid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') {
          parentGone = true;
        }
      }
    }
    if (reparented || parentGone) {
      _originalStderrWrite(
        `[daemon] Parent process (ppid=${initialPpid}) is gone (current ppid=${currentPpid}), exiting\n`,
        'utf8'
      );
      // Parent is dead — skip graceful cleanup to exit immediately.
      // sendDaemonEvent/shutdownPersistentRuntimes are intentionally omitted:
      // the Java side cannot receive events, and the OS will reclaim sockets on exit.
      isDaemonMode = false;
      _originalExit(0);
    }
  }, PPID_CHECK_INTERVAL_MS);
  ppidMonitor.unref();

  // --- Keep alive ---
  // The process stays alive as long as stdin is open (rl keeps the event loop active)
})();
