import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPatchFromExecCommand,
  extractPatchFromResponseItemPayload,
  extractPatchFromShellCommand,
  parseApplyPatchToOperations,
} from './codex-patch-parser.js';

const UPDATE_PATCH = [
  '*** Begin Patch',
  '*** Update File: src/main/App.java',
  '@@ -1,2 +1,2 @@',
  '-old line',
  '+new line',
  ' context line',
  '*** End Patch',
].join('\n');

const ADD_PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new/File.java',
  '+first line',
  '+second line',
  '*** End Patch',
].join('\n');

// ---- shell_command shape (Codex SDK 0.144.x) ----

test('shell_command argv array shape: patch text extracted from command[1]', () => {
  const payload = {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-shell-argv',
    arguments: JSON.stringify({ command: ['apply_patch', UPDATE_PATCH] }),
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), UPDATE_PATCH);
});

test('shell_command argv array shape: add-file patch parsed to write operation', () => {
  const payload = {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-shell-argv-add',
    arguments: JSON.stringify({ command: ['apply_patch', ADD_PATCH] }),
  };

  const patchText = extractPatchFromResponseItemPayload(payload);
  const operations = parseApplyPatchToOperations(patchText);

  assert.equal(operations.length, 1);
  assert.equal(operations[0].filePath, 'src/new/File.java');
  assert.equal(operations[0].toolName, 'write');
  assert.equal(operations[0].oldString, '');
  assert.equal(operations[0].newString, 'first line\nsecond line');
});

test('shell_command argv array tolerates wrapper entries before the patch text', () => {
  const payload = {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-shell-wrapped',
    arguments: JSON.stringify({ command: ['bash', '-lc', `apply_patch <<'EOF'\n${UPDATE_PATCH}\nEOF`] }),
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), UPDATE_PATCH);
});

test('shell_command string command shape (heredoc) extracts patch markers region', () => {
  const payload = {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-shell-string',
    arguments: JSON.stringify({ command: `apply_patch <<'PATCH_EOF'\n${UPDATE_PATCH}\nPATCH_EOF` }),
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), UPDATE_PATCH);
});

test('shell_command cmd string variant extracts patch', () => {
  const payload = {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-shell-cmd',
    arguments: JSON.stringify({ cmd: `apply_patch ${UPDATE_PATCH}` }),
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), UPDATE_PATCH);
});

// ---- legacy shapes (regression) ----

test('custom_tool_call apply_patch with string input still works', () => {
  const payload = {
    type: 'custom_tool_call',
    name: 'apply_patch',
    call_id: 'call-custom-1',
    input: UPDATE_PATCH,
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), UPDATE_PATCH);
});

test('custom_tool_call apply_patch with object input still works', () => {
  const payload = {
    type: 'custom_tool_call',
    name: 'apply_patch',
    call_id: 'call-custom-2',
    input: { patch: UPDATE_PATCH },
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), UPDATE_PATCH);
});

test('function_call apply_patch with patch arguments field still works', () => {
  const payload = {
    type: 'function_call',
    name: 'apply_patch',
    call_id: 'call-fn-patch',
    arguments: JSON.stringify({ patch: UPDATE_PATCH }),
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), UPDATE_PATCH);
});

test('function_call exec_command with cmd string still works', () => {
  const payload = {
    type: 'function_call',
    name: 'exec_command',
    call_id: 'call-exec-1',
    arguments: JSON.stringify({ cmd: `apply_patch <<'EOF'\n${UPDATE_PATCH}\nEOF` }),
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), UPDATE_PATCH);
});

// ---- malformed inputs return empty (never throw) ----

test('malformed arguments JSON returns empty', () => {
  const payload = {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-bad-json',
    arguments: '{"command": ["apply_patch", ',
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), '');
});

test('shell_command argv without patch markers returns empty', () => {
  const payload = {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-no-markers',
    arguments: JSON.stringify({ command: ['apply_patch', '--help'] }),
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), '');
});

test('shell_command string command without End marker returns empty', () => {
  const payload = {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-no-end',
    arguments: JSON.stringify({ command: 'apply_patch *** Begin Patch\n*** Update File: a.java\n+x' }),
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), '');
});

test('shell_command with non-string arguments returns empty', () => {
  const payload = {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-obj-args',
    arguments: { command: ['apply_patch', UPDATE_PATCH] },
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), '');
});

test('null / non-object payloads return empty', () => {
  assert.equal(extractPatchFromResponseItemPayload(null), '');
  assert.equal(extractPatchFromResponseItemPayload(undefined), '');
  assert.equal(extractPatchFromResponseItemPayload('shell_command'), '');
});

test('unrelated tool names return empty', () => {
  const payload = {
    type: 'function_call',
    name: 'read_file',
    call_id: 'call-other',
    arguments: JSON.stringify({ command: ['apply_patch', UPDATE_PATCH] }),
  };

  assert.equal(extractPatchFromResponseItemPayload(payload), '');
});

// ---- extractPatchFromShellCommand / extractPatchFromExecCommand units ----

test('extractPatchFromShellCommand returns empty for non-string or blank input', () => {
  assert.equal(extractPatchFromShellCommand(null), '');
  assert.equal(extractPatchFromShellCommand(undefined), '');
  assert.equal(extractPatchFromShellCommand(''), '');
  assert.equal(extractPatchFromShellCommand(42), '');
});

test('extractPatchFromExecCommand slices between Begin/End markers', () => {
  assert.equal(extractPatchFromExecCommand(`prefix ${UPDATE_PATCH} suffix`), UPDATE_PATCH);
  assert.equal(extractPatchFromExecCommand('no markers here'), '');
  assert.equal(extractPatchFromExecCommand(null), '');
});

// ---- parseApplyPatchToOperations sanity ----

test('parseApplyPatchToOperations parses update patch into edit operation', () => {
  const operations = parseApplyPatchToOperations(UPDATE_PATCH);

  assert.equal(operations.length, 1);
  assert.equal(operations[0].filePath, 'src/main/App.java');
  assert.equal(operations[0].kind, 'update');
  assert.equal(operations[0].toolName, 'edit');
  assert.equal(operations[0].oldString, 'old line\ncontext line');
  assert.equal(operations[0].newString, 'new line\ncontext line');
});

test('parseApplyPatchToOperations returns empty for blank text', () => {
  assert.deepEqual(parseApplyPatchToOperations(''), []);
  assert.deepEqual(parseApplyPatchToOperations(null), []);
});
