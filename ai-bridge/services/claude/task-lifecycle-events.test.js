import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskLifecycleEvent,
  processTaskLifecycleEvent,
  isSidechainMessage,
  trimSidechainMessage,
} from './stream-event-processor.js';
import { initEmitter } from '../../protocol/emitter.js';

// Capture structured v2 envelopes emitted via protocol/emitter.js.
function captureStdout(fn) {
  const captured = [];
  initEmitter((obj) => captured.push(obj));
  try {
    fn();
  } finally {
    initEmitter(null);
  }
  return captured;
}

// ========== buildTaskLifecycleEvent / processTaskLifecycleEvent ==========

test('task_started → started payload with ids and description', () => {
  const payload = buildTaskLifecycleEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    tool_use_id: 'toolu_1',
    description: 'Count files',
    subagent_type: 'Explore',
  });
  assert.deepEqual(payload, {
    kind: 'started',
    taskId: 'task-1',
    toolUseId: 'toolu_1',
    description: 'Count files',
    subagentType: 'Explore',
  });
});

test('task_progress → progress payload with camelCase usage', () => {
  const payload = buildTaskLifecycleEvent({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task-1',
    tool_use_id: 'toolu_1',
    description: 'Finding *.md',
    subagent_type: 'Explore',
    last_tool_name: 'Glob',
    usage: { total_tokens: 9335, tool_uses: 2, duration_ms: 11518 },
  });
  assert.equal(payload.kind, 'progress');
  assert.equal(payload.lastToolName, 'Glob');
  assert.deepEqual(payload.usage, { totalTokens: 9335, toolUses: 2, durationMs: 11518 });
});

test('task_notification → notification payload with status and summary', () => {
  const payload = buildTaskLifecycleEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    tool_use_id: 'toolu_1',
    status: 'completed',
    summary: 'Found 778 files',
    usage: { total_tokens: 100, tool_uses: 3, duration_ms: 5000 },
  });
  assert.equal(payload.kind, 'notification');
  assert.equal(payload.status, 'completed');
  assert.equal(payload.summary, 'Found 778 files');
});

test('task_updated → updated payload with patch', () => {
  const payload = buildTaskLifecycleEvent({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'task-1',
    patch: { status: 'completed', end_time: 123 },
  });
  assert.deepEqual(payload, { kind: 'updated', taskId: 'task-1', patch: { status: 'completed', end_time: 123 } });
});

test('tool_progress → tool_progress payload (main chain and subagent)', () => {
  const mainChain = buildTaskLifecycleEvent({
    type: 'tool_progress',
    tool_use_id: 'toolu_main',
    tool_name: 'Bash',
    parent_tool_use_id: null,
    elapsed_time_seconds: 42.5,
  });
  assert.deepEqual(mainChain, {
    kind: 'tool_progress',
    toolUseId: 'toolu_main',
    toolName: 'Bash',
    parentToolUseId: null,
    taskId: undefined,
    elapsedTimeSeconds: 42.5,
  });

  const subagent = buildTaskLifecycleEvent({
    type: 'tool_progress',
    tool_use_id: 'toolu_sub',
    tool_name: 'Grep',
    parent_tool_use_id: 'toolu_agent',
    task_id: 'task-1',
    elapsed_time_seconds: 3,
  });
  assert.equal(subagent.parentToolUseId, 'toolu_agent');
  assert.equal(subagent.taskId, 'task-1');
});

test('unrelated messages (assistant, user, init, compact status) are ignored', () => {
  assert.equal(buildTaskLifecycleEvent({ type: 'assistant', message: { content: [] } }), null);
  assert.equal(buildTaskLifecycleEvent({ type: 'user', message: { content: [] } }), null);
  assert.equal(buildTaskLifecycleEvent({ type: 'system', subtype: 'init' }), null);
  assert.equal(buildTaskLifecycleEvent({ type: 'system', subtype: 'status', status: 'compacting' }), null);
  assert.equal(buildTaskLifecycleEvent(null), null);
  assert.equal(buildTaskLifecycleEvent(undefined), null);
});

test('processTaskLifecycleEvent emits task_event envelope and returns true', () => {
  const captured = captureStdout(() => {
    const handled = processTaskLifecycleEvent({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'toolu_1',
      description: 'd',
      subagent_type: 'Explore',
    });
    assert.equal(handled, true);
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].type, 'task_event');
  assert.equal(captured[0].data.kind, 'started');
});

test('processTaskLifecycleEvent ignores unrelated messages without emitting', () => {
  const captured = captureStdout(() => {
    assert.equal(processTaskLifecycleEvent({ type: 'system', subtype: 'init' }), false);
  });
  assert.equal(captured.length, 0);
});

test('usage normalization drops missing/non-numeric values', () => {
  const payload = buildTaskLifecycleEvent({
    type: 'system',
    subtype: 'task_progress',
    task_id: 't',
    usage: { total_tokens: 'oops', tool_uses: 2 },
  });
  assert.deepEqual(payload.usage, { totalTokens: undefined, toolUses: 2, durationMs: undefined });

  const noUsage = buildTaskLifecycleEvent({ type: 'system', subtype: 'task_progress', task_id: 't' });
  assert.equal(noUsage.usage, undefined);
});

// ========== isSidechainMessage / trimSidechainMessage ==========

test('isSidechainMessage: assistant/user with parent_tool_use_id is sidechain', () => {
  assert.equal(isSidechainMessage({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [] } }), true);
  assert.equal(isSidechainMessage({ type: 'user', parent_tool_use_id: 'toolu_1', message: { content: [] } }), true);
});

test('isSidechainMessage: main-chain messages and other types are not sidechain', () => {
  assert.equal(isSidechainMessage({ type: 'assistant', parent_tool_use_id: null, message: { content: [] } }), false);
  assert.equal(isSidechainMessage({ type: 'assistant', message: { content: [] } }), false);
  assert.equal(isSidechainMessage({ type: 'system', subtype: 'task_started', parent_tool_use_id: 'toolu_1' }), false);
  assert.equal(isSidechainMessage(null), false);
});

test('trimSidechainMessage: tool_use blocks keep id/name and small scalar input fields', () => {
  const trimmed = trimSidechainMessage({
    type: 'assistant',
    parent_tool_use_id: 'toolu_agent',
    message: {
      content: [
        { type: 'text', text: 'subagent thinking out loud' },
        {
          type: 'tool_use',
          id: 'toolu_sub_1',
          name: 'Write',
          input: {
            file_path: '/tmp/a.txt',
            content: 'x'.repeat(5000),
            nested: { big: 'payload' },
            limit: 10,
          },
        },
      ],
    },
  });
  assert.equal(trimmed.parentToolUseId, 'toolu_agent');
  assert.equal(trimmed.role, 'assistant');
  assert.equal(trimmed.blocks.length, 1);
  const block = trimmed.blocks[0];
  assert.equal(block.type, 'tool_use');
  assert.equal(block.id, 'toolu_sub_1');
  assert.equal(block.name, 'Write');
  assert.equal(block.input.file_path, '/tmp/a.txt');
  assert.equal(block.input.limit, 10);
  assert.equal(block.input.nested, undefined);
  assert.ok(block.input.content.length <= 201, 'long strings are truncated');
});

test('trimSidechainMessage: tool_result blocks keep id and error flag only', () => {
  const trimmed = trimSidechainMessage({
    type: 'user',
    parent_tool_use_id: 'toolu_agent',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_sub_1', is_error: true, content: 'huge output…' },
      ],
    },
  });
  assert.equal(trimmed.role, 'user');
  assert.deepEqual(trimmed.blocks, [{ type: 'tool_result', tool_use_id: 'toolu_sub_1', is_error: true }]);
});

test('trimSidechainMessage: messages without tool blocks return null', () => {
  assert.equal(trimSidechainMessage({
    type: 'assistant',
    parent_tool_use_id: 'toolu_agent',
    message: { content: [{ type: 'text', text: 'just words' }] },
  }), null);
  assert.equal(trimSidechainMessage({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { content: 'str' } }), null);
  assert.equal(trimSidechainMessage({ type: 'assistant', message: { content: [] } }), null);
});
