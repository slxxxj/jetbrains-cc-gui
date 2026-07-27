import { emitAccumulatedUsage, mergeUsage } from '../../utils/usage-utils.js';
import { truncateErrorContent, truncateToolResultBlock } from './message-output-filter.js';
import { normalizeStreamDelta, resolveSnapshotDelta, resetTurnBlockState } from './stream-delta-normalizer.js';
import { emit } from '../../protocol/emitter.js';

export function emitUsageTag(msg) {
  if (msg.type === 'assistant' && msg.message?.usage) {
    const {
      input_tokens = 0,
      output_tokens = 0,
      cache_creation_input_tokens = 0,
      cache_read_input_tokens = 0
    } = msg.message.usage;
    emit('usage', {
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens
    });
  }
}

export function createTurnState(requestContext, runtime) {
  return {
    streamingEnabled: requestContext.streamingEnabled,
    streamStarted: false,
    streamEnded: false,
    hasStreamEvents: false,
    lastAssistantContent: '',
    lastThinkingContent: '',
    textBlockContentByIndex: new Map(),
    thinkingBlockContentByIndex: new Map(),
    finalSessionId: requestContext.requestedSessionId || runtime?.sessionId || '',
    accumulatedUsage: null
  };
}

export function processStreamEvent(msg, turnState) {
  const event = msg.event;
  if (!event) return;

  if (event.type === 'message_start') {
    // Turn boundary: each assistant message (incl. every tool_use loop iteration)
    // re-numbers its content blocks from index 0. Clear the index-keyed block maps
    // so the prior turn's accumulator / locked stream-mode cannot corrupt or
    // duplicate this turn's index-0 block (see resetTurnBlockState). Usage still
    // accumulates across turns.
    resetTurnBlockState(turnState);
    // Emit BLOCK_RESET signal BEFORE any subsequent deltas to ensure frontend
    // clears its streaming refs (streamingThinkingRef, streamingContentRef).
    // This prevents new turn's thinking/text from merging with previous turn's content.
    // Must emit synchronously here, not in the delta handlers, to guarantee ordering.
    if (turnState.streamingEnabled) {
      emit('block_reset');
    }
    if (event.message?.usage) {
      turnState.accumulatedUsage = mergeUsage(turnState.accumulatedUsage, event.message.usage);
    }
  }

  if (event.type === 'message_delta' && event.usage) {
    turnState.accumulatedUsage = mergeUsage(turnState.accumulatedUsage, event.usage);
    emitAccumulatedUsage(turnState.accumulatedUsage);
  }

  if (event.type === 'content_block_delta' && event.delta) {
    if (event.delta.type === 'text_delta' && event.delta.text) {
      const delta = normalizeStreamDelta(turnState, 'text', event.index, event.delta.text);
      if (delta) {
        emit('content_delta', delta);
        turnState.lastAssistantContent += delta;
      }
    } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
      const delta = normalizeStreamDelta(turnState, 'thinking', event.index, event.delta.thinking);
      if (delta) {
        emit('thinking_delta', delta);
        turnState.lastThinkingContent += delta;
      }
    }
  }

  // A tool_use block start arrives BEFORE the (possibly multi-second) stream of
  // input_json_delta fragments that carry its arguments, and long before the
  // complete assistant snapshot that renders the tool card. Forward the tool
  // name once here so the UI can show a "preparing tool call" hint during the
  // otherwise silent argument-generation phase. The individual input_json_delta
  // fragments are deliberately NOT forwarded (high volume, no UI value).
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    emit('tool_preparing', {
      name: event.content_block.name || '',
      index: typeof event.index === 'number' ? event.index : 0
    });
  }
}

/**
 * Forward context-compaction lifecycle signals carried by SDK system messages.
 *
 * The SDK (claude-agent-sdk sdk.d.ts) declares two relevant shapes:
 *   - SDKStatusMessage: {type:'system', subtype:'status',
 *       status:'compacting'|'requesting'|null, compact_result?, compact_error?}
 *     'compacting' marks compaction start; any other status value marks its end.
 *   - SDKCompactBoundaryMessage: {type:'system', subtype:'compact_boundary',
 *       compact_metadata:{trigger, pre_tokens, post_tokens?, duration_ms?}}
 *     Written after a compaction completed — treated as an end signal too, so a
 *     missed status transition cannot leave the UI stuck in "compacting".
 *
 * Both are normalized into a single 'compact_status' envelope: {compacting}
 * plus optional trigger metadata on the boundary-derived end signal.
 */
export function processSystemMessage(msg) {
  if (msg?.type !== 'system') return;
  if (msg.subtype === 'status') {
    emit('compact_status', { compacting: msg.status === 'compacting' });
  } else if (msg.subtype === 'compact_boundary') {
    emit('compact_status', {
      compacting: false,
      trigger: msg.compact_metadata?.trigger === 'manual' ? 'manual' : 'auto'
    });
  }
}

export function processMessageContent(msg, turnState) {
  if (msg.type !== 'assistant') return;
  const content = msg.message?.content;

  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i += 1) {
      const block = content[i];
      if (block.type === 'text') {
        emitSnapshotText(block.text || '', turnState, i);
      } else if (block.type === 'thinking') {
        emitSnapshotThinking(block.thinking || block.text || '', turnState, i);
      }
    }
  } else if (typeof content === 'string') {
    emitSnapshotText(content, turnState, 0);
  }
}

/**
 * Emit a text block carried by an assistant snapshot.
 *
 * Routes the full snapshot through resolveSnapshotDelta — the same novelty/
 * correction engine the live delta path uses — so a mid-stream corrective
 * rewrite is absorbed rather than mis-sliced by a naive substring, and the
 * block map / mode bookkeeping stay single-sourced.
 *
 * Emit gate (unchanged from the tail-fill / new-block-suppression fix):
 *   - !hasStreamEvents: pre-stream fallback, emit the whole computed delta
 *   - hasStreamEvents && hadPrevious: genuine tail-fill / snapshot correction
 *   - hasStreamEvents && !hadPrevious: stream will deliver this block, suppress
 */
function emitSnapshotText(currentText, turnState, blockIndex) {
  if (!turnState.streamingEnabled) {
    emit('content', truncateErrorContent(currentText));
    return;
  }
  const { delta, hadPrevious } = resolveSnapshotDelta(turnState, 'text', blockIndex, currentText);
  if (delta && (!turnState.hasStreamEvents || hadPrevious)) {
    emit('content_delta', delta);
  }
  turnState.lastAssistantContent = currentText;
}

/** Thinking-block counterpart to {@link emitSnapshotText}. */
function emitSnapshotThinking(thinkingText, turnState, blockIndex) {
  if (!turnState.streamingEnabled) {
    emit('thinking', thinkingText);
    return;
  }
  const { delta, hadPrevious } = resolveSnapshotDelta(turnState, 'thinking', blockIndex, thinkingText);
  if (delta && (!turnState.hasStreamEvents || hadPrevious)) {
    emit('thinking_delta', delta);
  }
  turnState.lastThinkingContent = thinkingText;
}

export function processToolResultMessages(msg) {
  if (msg.type !== 'user') return;
  const content = msg.message?.content ?? msg.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === 'tool_result') {
      emit('tool_result', truncateToolResultBlock(block));
    }
  }
}

/**
 * Normalize the usage object carried by task_progress / task_notification
 * messages ({total_tokens, tool_uses, duration_ms}) into camelCase.
 * Returns undefined when no usable numbers are present.
 */
function normalizeTaskUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const normalized = {
    totalTokens: num(usage.total_tokens),
    toolUses: num(usage.tool_uses),
    durationMs: num(usage.duration_ms),
  };
  if (normalized.totalTokens === undefined && normalized.toolUses === undefined && normalized.durationMs === undefined) {
    return undefined;
  }
  return normalized;
}

/**
 * Build the 'task_event' payload for an SDK background-task lifecycle message,
 * or return null when the message is not one. See processTaskLifecycleEvent for
 * the covered shapes. Kept pure so the inter-turn path (perpetual reader) can
 * forward the same payload over the untagged daemon-event channel instead of
 * the request-scoped emit() channel.
 */
export function buildTaskLifecycleEvent(msg) {
  if (!msg || typeof msg !== 'object') return null;

  if (msg.type === 'tool_progress') {
    return {
      kind: 'tool_progress',
      toolUseId: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : undefined,
      toolName: typeof msg.tool_name === 'string' ? msg.tool_name : undefined,
      parentToolUseId: typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : null,
      taskId: typeof msg.task_id === 'string' ? msg.task_id : undefined,
      elapsedTimeSeconds: typeof msg.elapsed_time_seconds === 'number' ? msg.elapsed_time_seconds : undefined,
    };
  }

  if (msg.type !== 'system') return null;

  switch (msg.subtype) {
    case 'task_started':
      return {
        kind: 'started',
        taskId: typeof msg.task_id === 'string' ? msg.task_id : undefined,
        toolUseId: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : undefined,
        description: typeof msg.description === 'string' ? msg.description : undefined,
        subagentType: typeof msg.subagent_type === 'string' ? msg.subagent_type : undefined,
      };
    case 'task_progress':
      return {
        kind: 'progress',
        taskId: typeof msg.task_id === 'string' ? msg.task_id : undefined,
        toolUseId: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : undefined,
        description: typeof msg.description === 'string' ? msg.description : undefined,
        subagentType: typeof msg.subagent_type === 'string' ? msg.subagent_type : undefined,
        lastToolName: typeof msg.last_tool_name === 'string' ? msg.last_tool_name : undefined,
        summary: typeof msg.summary === 'string' ? msg.summary : undefined,
        usage: normalizeTaskUsage(msg.usage),
      };
    case 'task_notification':
      return {
        kind: 'notification',
        taskId: typeof msg.task_id === 'string' ? msg.task_id : undefined,
        toolUseId: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : undefined,
        status: typeof msg.status === 'string' ? msg.status : undefined,
        summary: typeof msg.summary === 'string' ? msg.summary : undefined,
        usage: normalizeTaskUsage(msg.usage),
      };
    case 'task_updated':
      return {
        kind: 'updated',
        taskId: typeof msg.task_id === 'string' ? msg.task_id : undefined,
        patch: msg.patch && typeof msg.patch === 'object' ? msg.patch : undefined,
      };
    default:
      return null;
  }
}

/**
 * Forward SDK background-task lifecycle signals as 'task_event' envelopes.
 *
 * Covers the async subagent (Agent/Task tool) lifecycle plus per-tool
 * heartbeats — the data the UI needs to render Cursor-style live progress:
 *   - system/task_started      → {kind:'started', taskId, toolUseId, description, subagentType}
 *   - system/task_progress     → {kind:'progress', ..., lastToolName, summary, usage}
 *   - system/task_notification → {kind:'notification', ..., status, summary, usage}
 *   - system/task_updated      → {kind:'updated', taskId, patch}
 *   - tool_progress (top-level) → {kind:'tool_progress', toolUseId, toolName,
 *     parentToolUseId, taskId, elapsedTimeSeconds} — heartbeat emitted while a
 *     long-running tool executes, main chain and subagent tools alike. This is
 *     what lets the UI prove "still working" during an otherwise silent stretch.
 *
 * Returns true when the message was a task lifecycle event.
 */
export function processTaskLifecycleEvent(msg) {
  const payload = buildTaskLifecycleEvent(msg);
  if (!payload) return false;
  emit('task_event', payload);
  return true;
}

/**
 * Whether an SDK message belongs to a subagent's internal conversation
 * (assistant/user message with parent_tool_use_id set). Such messages must NOT
 * be merged into the main assistant bubble — the UI nests them under the
 * spawning agent card instead.
 */
export function isSidechainMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type !== 'assistant' && msg.type !== 'user') return false;
  return typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id.length > 0;
}

const SIDECHAIN_FIELD_MAX = 200;

/**
 * Keep only small scalar fields of a tool_use input for step-summary rendering
 * (file_path, command, pattern, …). Each string is truncated; nested objects
 * are dropped so the envelope stays small even for huge Write payloads.
 */
function pickSidechainInputSummary(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const summary = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      summary[key] = value.length > SIDECHAIN_FIELD_MAX ? value.slice(0, SIDECHAIN_FIELD_MAX) + '…' : value;
      count += 1;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      summary[key] = value;
      count += 1;
    }
    if (count >= 8) break;
  }
  return count > 0 ? summary : undefined;
}

/**
 * Reduce a sidechain SDK message to the lean shape the UI needs for nested
 * step rendering:
 *   { parentToolUseId, role, blocks: [
 *     {type:'tool_use', id, name, input} | {type:'tool_result', tool_use_id, is_error} ] }
 * Returns null when the message carries no renderable tool blocks.
 */
export function trimSidechainMessage(msg) {
  if (!isSidechainMessage(msg)) return null;
  const content = msg.message?.content ?? msg.content;
  if (!Array.isArray(content)) return null;
  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      blocks.push({
        type: 'tool_use',
        id: block.id,
        name: typeof block.name === 'string' ? block.name : '',
        input: pickSidechainInputSummary(block.input),
      });
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      blocks.push({
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        is_error: block.is_error === true,
      });
    }
  }
  if (blocks.length === 0) return null;
  return {
    parentToolUseId: msg.parent_tool_use_id,
    role: msg.type,
    blocks,
  };
}

export function shouldOutputMessage(msg, turnState) {
  // Always output non-assistant messages
  if (msg.type !== 'assistant') {
    return true;
  }

  // Non-streaming mode: always output
  if (!turnState.streamingEnabled) {
    return true;
  }

  // Streaming mode: only emit a 'message' envelope when the snapshot carries
  // tool_use blocks. Pure text/thinking content is delivered via
  // 'content_delta' / 'thinking_delta' envelopes (processStreamEvent for live
  // deltas, processMessageContent for tail-fill). Mirrors the legacy
  // message-sender.js shouldOutput rule. Emitting redundant 'message' envelopes
  // for text-only assistants forces the Java ReplayDeduplicator to reconcile
  // the same content twice and was the upstream cause of duplicated markdown
  // blocks reported on v0.4.x streaming.
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === 'tool_use');
}
