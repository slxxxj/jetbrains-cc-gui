import test from 'node:test';
import assert from 'node:assert/strict';

import {
  failAllPendingDaemonPermissionRequests,
  handleDaemonPermissionResponse,
  initDaemonPermissionChannel,
  isDaemonPermissionChannelActive,
  requestAskUserQuestionAnswers,
  requestPermissionFromJava,
  requestPlanApproval,
  requestViaDaemonChannel,
} from './permission-ipc.js';
import { canUseTool } from './permission-handler.js';

// Capturing sender: records every envelope the channel would write to the
// daemon's stdout and lets each test drive the Java-side response.
function createSender() {
  const sent = [];
  return {
    sent,
    send(obj) {
      sent.push(obj);
    },
  };
}

// The channel is process-global; initialize once with a sender whose capture
// list each test can slice. Tests run sequentially within this file.
const sender = createSender();
initDaemonPermissionChannel(sender.send);

test('daemon permission channel is active after init', () => {
  assert.equal(isDaemonPermissionChannelActive(), true);
});

test('tool permission round trip: explicit allow === true grants', async () => {
  const before = sender.sent.length;
  const pending = requestPermissionFromJava('Bash', { command: 'ls' });

  assert.equal(sender.sent.length, before + 1);
  const envelope = sender.sent[before];
  assert.equal(envelope.type, 'permission_request');
  assert.equal(typeof envelope.requestId, 'string');
  assert.equal(envelope.payload.kind, 'tool');
  assert.equal(envelope.payload.toolName, 'Bash');
  assert.deepEqual(envelope.payload.input, { command: 'ls' });
  assert.equal(typeof envelope.payload.sessionId, 'string');
  assert.equal(typeof envelope.payload.cwd, 'string');
  assert.equal(typeof envelope.payload.timestamp, 'string');

  handleDaemonPermissionResponse({
    type: 'permission_response',
    requestId: envelope.requestId,
    decision: { allow: true },
  });

  assert.equal(await pending, true);
});

test('tool permission denies on truthy-but-non-boolean allow values', async () => {
  for (const decision of [{ allow: 'true' }, { allow: 1 }, { allow: 'yes' }, {}, null]) {
    const before = sender.sent.length;
    const pending = requestPermissionFromJava('Bash', { command: 'ls' });
    handleDaemonPermissionResponse({
      type: 'permission_response',
      requestId: sender.sent[before].requestId,
      decision,
    });
    assert.equal(await pending, false, `decision ${JSON.stringify(decision)} must deny`);
  }
});

test('tool permission denies on explicit deny', async () => {
  const before = sender.sent.length;
  const pending = requestPermissionFromJava('Edit', { file_path: '/tmp/a.txt' });
  handleDaemonPermissionResponse({
    type: 'permission_response',
    requestId: sender.sent[before].requestId,
    decision: { allow: false },
  });
  assert.equal(await pending, false);
});

test('orphan responses are ignored and never grant anything', async () => {
  // Unknown request id: must be a no-op (no throw, no resolution).
  handleDaemonPermissionResponse({
    type: 'permission_response',
    requestId: 'never-issued',
    decision: { allow: true },
  });
  handleDaemonPermissionResponse(null);
  handleDaemonPermissionResponse({ type: 'permission_response' });

  // A response that arrives BEFORE the request (replay attempt) must not
  // pre-authorize the next request issued with a colliding id.
  const before = sender.sent.length;
  const pending = requestPermissionFromJava('Bash', { command: 'ls' });
  const requestId = sender.sent[before].requestId;
  handleDaemonPermissionResponse({ type: 'permission_response', requestId, decision: {} });
  assert.equal(await pending, false);
});

test('daemon channel timeout resolves undefined (callers deny)', async () => {
  const decision = await requestViaDaemonChannel('timeout-1', 'tool', { toolName: 'Bash' }, 50);
  assert.equal(decision, undefined);

  // Late response for the timed-out request is an orphan: ignored.
  handleDaemonPermissionResponse({
    type: 'permission_response',
    requestId: 'timeout-1',
    decision: { allow: true },
  });
});

test('failAllPendingDaemonPermissionRequests resolves pending requests with deny default', async () => {
  const before = sender.sent.length;
  const pending = requestPermissionFromJava('Bash', { command: 'ls' });
  assert.ok(sender.sent.length > before);
  failAllPendingDaemonPermissionRequests();
  assert.equal(await pending, false);
});

test('ask-user-question round trip passes the answers object through', async () => {
  const before = sender.sent.length;
  const pending = requestAskUserQuestionAnswers({ questions: [{ question: 'Pick one' }] });

  const envelope = sender.sent[before];
  assert.equal(envelope.payload.kind, 'ask_user_question');
  assert.equal(envelope.payload.toolName, 'AskUserQuestion');
  assert.deepEqual(envelope.payload.questions, [{ question: 'Pick one' }]);
  assert.ok(envelope.requestId.startsWith('ask-'));

  handleDaemonPermissionResponse({
    type: 'permission_response',
    requestId: envelope.requestId,
    decision: { answers: { 'Pick one': 'Option A' } },
  });

  assert.deepEqual(await pending, { 'Pick one': 'Option A' });
});

test('ask-user-question returns null for non-object answers', async () => {
  for (const decision of [{ answers: 'yes' }, { answers: 42 }, {}, null]) {
    const before = sender.sent.length;
    const pending = requestAskUserQuestionAnswers({ questions: [] });
    handleDaemonPermissionResponse({
      type: 'permission_response',
      requestId: sender.sent[before].requestId,
      decision,
    });
    assert.equal(await pending, null, `decision ${JSON.stringify(decision)} must yield null`);
  }
});

test('plan approval round trip: only approved === true approves', async () => {
  const before = sender.sent.length;
  const pending = requestPlanApproval({
    plan: 'do the thing',
    allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }, { tool: 1 }, null],
  });

  const envelope = sender.sent[before];
  assert.equal(envelope.payload.kind, 'plan_approval');
  assert.equal(envelope.payload.toolName, 'ExitPlanMode');
  assert.equal(envelope.payload.plan, 'do the thing');
  assert.deepEqual(envelope.payload.allowedPrompts, [{ tool: 'Bash', prompt: 'run tests' }]);
  assert.ok(envelope.requestId.startsWith('plan-'));

  handleDaemonPermissionResponse({
    type: 'permission_response',
    requestId: envelope.requestId,
    decision: { approved: true, targetMode: 'acceptEdits' },
  });

  assert.deepEqual(await pending, { approved: true, targetMode: 'acceptEdits', message: undefined });
});

test('plan approval rejects truthy-but-non-boolean approved and defaults targetMode', async () => {
  for (const [decision, expectedApproved] of [
    [{ approved: 'true' }, false],
    [{ approved: 1 }, false],
    [{ approved: false }, false],
    [{}, false],
  ]) {
    const before = sender.sent.length;
    const pending = requestPlanApproval({ plan: 'x' });
    handleDaemonPermissionResponse({
      type: 'permission_response',
      requestId: sender.sent[before].requestId,
      decision,
    });
    const result = await pending;
    assert.equal(result.approved, expectedApproved);
    assert.equal(result.targetMode, 'default');
  }
});

test('canUseTool end-to-end over the daemon channel: allow and deny', async () => {
  const allowBefore = sender.sent.length;
  const allowPending = canUseTool('Bash', { command: 'echo hi' });
  handleDaemonPermissionResponse({
    type: 'permission_response',
    requestId: sender.sent[allowBefore].requestId,
    decision: { allow: true },
  });
  const allowResult = await allowPending;
  assert.equal(allowResult.behavior, 'allow');
  assert.deepEqual(allowResult.updatedInput, { command: 'echo hi' });

  const denyBefore = sender.sent.length;
  const denyPending = canUseTool('Bash', { command: 'rm -rf /tmp/x' });
  handleDaemonPermissionResponse({
    type: 'permission_response',
    requestId: sender.sent[denyBefore].requestId,
    decision: { allow: false },
  });
  const denyResult = await denyPending;
  assert.equal(denyResult.behavior, 'deny');
});

test('canUseTool safe-listed tools never touch the daemon channel', async () => {
  const before = sender.sent.length;
  const result = await canUseTool('Read', { file_path: '/tmp/a.txt' });
  assert.equal(result.behavior, 'allow');
  assert.equal(sender.sent.length, before);
});
