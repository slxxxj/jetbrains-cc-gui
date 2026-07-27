import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_MODE_DISALLOWED_TOOLS,
  buildChatModePromptAppend,
  normalizeChatMode
} from './chat-mode.js';
import { buildRuntimeSignature } from './runtime-lifecycle.js';
import { __testing } from './persistent-query-service.js';

test.beforeEach(async () => {
  await __testing.resetState();
});

test.after(async () => {
  await __testing.resetState();
});

// ========== normalizeChatMode ==========

test('normalizeChatMode returns each valid value unchanged', () => {
  for (const mode of ['agent', 'ask', 'plan', 'debug', 'multitask']) {
    assert.equal(normalizeChatMode(mode), mode);
  }
});

test('normalizeChatMode falls back to agent for absent or blank values', () => {
  assert.equal(normalizeChatMode(undefined), 'agent');
  assert.equal(normalizeChatMode(null), 'agent');
  assert.equal(normalizeChatMode(''), 'agent');
  assert.equal(normalizeChatMode('   '), 'agent');
});

test('normalizeChatMode warns and falls back to agent for unknown values', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.equal(normalizeChatMode('bogus'), 'agent');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unknown chat mode/);
});

// ========== buildChatModePromptAppend ==========

test('buildChatModePromptAppend returns null for agent and plan', () => {
  assert.equal(buildChatModePromptAppend('agent'), null);
  assert.equal(buildChatModePromptAppend('plan'), null);
  assert.equal(buildChatModePromptAppend(undefined), null);
});

test('buildChatModePromptAppend returns a read-only prompt for ask', () => {
  const prompt = buildChatModePromptAppend('ask');
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /Edit, Write, MultiEdit/);
});

test('buildChatModePromptAppend returns a debugging workflow for debug', () => {
  const prompt = buildChatModePromptAppend('debug');
  assert.match(prompt, /debugging/i);
  assert.match(prompt, /Reproduce/);
  assert.match(prompt, /Root cause/);
});

test('buildChatModePromptAppend returns a parallel-subagent prompt for multitask', () => {
  const prompt = buildChatModePromptAppend('multitask');
  assert.match(prompt, /multitask/i);
  assert.match(prompt, /Task subagents/);
});

// ========== buildRequestContext (persistent path) ==========

function baseParams(extra = {}) {
  return {
    sessionId: '',
    runtimeSessionEpoch: 'epoch-chatmode',
    cwd: process.cwd(),
    message: 'hello',
    agentPrompt: 'BASE_MARKER',
    ...extra
  };
}

test('chatMode plan overrides permissionMode to plan for this query', async () => {
  const context = await __testing.buildRequestContext(baseParams({
    chatMode: 'plan',
    permissionMode: 'acceptEdits'
  }), false);

  assert.equal(context.chatMode, 'plan');
  assert.equal(context.permissionMode, 'plan');
  assert.equal(context.options.permissionMode, 'plan');
  assert.match(context.runtimeSignature, /"chatMode":"plan"/);
});

test('chatMode agent leaves permissionMode normalization untouched', async () => {
  const context = await __testing.buildRequestContext(baseParams({
    chatMode: 'agent',
    permissionMode: 'acceptEdits'
  }), false);

  assert.equal(context.chatMode, 'agent');
  assert.equal(context.options.permissionMode, 'acceptEdits');
});

test('absent chatMode leaves permissionMode normalization untouched', async () => {
  const context = await __testing.buildRequestContext(baseParams({
    permissionMode: 'acceptEdits'
  }), false);

  assert.equal(context.chatMode, 'agent');
  assert.equal(context.options.permissionMode, 'acceptEdits');
});

test('chatMode ask disallows file-mutation tools and appends a read-only prompt', async () => {
  const context = await __testing.buildRequestContext(baseParams({ chatMode: 'ask' }), false);

  assert.equal(context.chatMode, 'ask');
  assert.deepEqual(context.options.disallowedTools, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  // Mode prompt composed WITH the existing append, after it — never clobbering.
  const append = context.options.systemPrompt.append;
  assert.match(append, /BASE_MARKER/);
  assert.match(append, /read-only/i);
  assert.ok(append.indexOf('BASE_MARKER') < append.indexOf('You are in read-only'));
});

test('non-ask modes do not set disallowedTools', async () => {
  for (const chatMode of ['agent', 'plan', 'debug', 'multitask']) {
    const context = await __testing.buildRequestContext(baseParams({ chatMode }), false);
    assert.equal(Object.hasOwn(context.options, 'disallowedTools'), false, `chatMode=${chatMode}`);
  }
});

test('chatMode debug appends the debugging workflow prompt', async () => {
  const context = await __testing.buildRequestContext(baseParams({ chatMode: 'debug' }), false);

  const append = context.options.systemPrompt.append;
  assert.match(append, /BASE_MARKER/);
  assert.match(append, /Root cause/);
});

test('chatMode multitask appends the parallel-subagent prompt', async () => {
  const context = await __testing.buildRequestContext(baseParams({ chatMode: 'multitask' }), false);

  const append = context.options.systemPrompt.append;
  assert.match(append, /BASE_MARKER/);
  assert.match(append, /Task subagents/);
});

test('chatMode agent leaves the systemPrompt append unchanged', async () => {
  const baseline = await __testing.buildRequestContext(baseParams(), false);
  const agent = await __testing.buildRequestContext(baseParams({ chatMode: 'agent' }), false);

  assert.equal(agent.options.systemPrompt.append, baseline.options.systemPrompt.append);
});

// ========== buildRuntimeSignature ==========

test('buildRuntimeSignature differs across chatMode values', () => {
  const options = { cwd: '/w', model: 'sonnet', additionalDirectories: [], permissionMode: 'default' };
  const sigAgent = buildRuntimeSignature(options, '', true, 'ep', 'sonnet', null, 'agent');
  const sigAsk = buildRuntimeSignature(options, '', true, 'ep', 'sonnet', null, 'ask');
  const sigPlan = buildRuntimeSignature(options, '', true, 'ep', 'sonnet', null, 'plan');
  const sigDebug = buildRuntimeSignature(options, '', true, 'ep', 'sonnet', null, 'debug');

  assert.notEqual(sigAgent, sigAsk);
  assert.notEqual(sigAgent, sigPlan);
  assert.notEqual(sigAgent, sigDebug);
  assert.equal(sigAsk, buildRuntimeSignature(options, '', true, 'ep', 'sonnet', null, 'ask'));
});

test('buildRuntimeSignature defaults chatMode to agent', () => {
  const options = { cwd: '/w', model: 'sonnet', additionalDirectories: [], permissionMode: 'default' };
  const sigDefault = buildRuntimeSignature(options, '', true, 'ep', 'sonnet', null);
  const sigAgent = buildRuntimeSignature(options, '', true, 'ep', 'sonnet', null, 'agent');

  assert.equal(sigDefault, sigAgent);
  assert.match(sigDefault, /"chatMode":"agent"/);
});

test('ASK_MODE_DISALLOWED_TOOLS contains exactly the file-mutation tools', () => {
  assert.deepEqual([...ASK_MODE_DISALLOWED_TOOLS], ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
});
