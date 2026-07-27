/**
 * Patch text parsing for Codex apply_patch operations.
 * Extracts and parses patch content from Codex SDK response payloads.
 */

/**
 * Extracts apply_patch text from exec_command arguments.
 */
export function extractPatchFromExecCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) {
    return '';
  }
  const begin = cmd.indexOf('*** Begin Patch');
  const end = cmd.lastIndexOf('*** End Patch');
  if (begin < 0 || end < begin) {
    return '';
  }
  return cmd.slice(begin, end + '*** End Patch'.length);
}

/**
 * Parses hunk header line numbers from unified diff headers.
 */
function parseHunkHeader(line) {
  if (typeof line !== 'string') {
    return null;
  }

  const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
  if (!match) {
    return null;
  }

  return {
    oldStart: Number(match[1]),
    oldCount: match[2] ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newCount: match[4] ? Number(match[4]) : 1,
  };
}

/**
 * Extracts apply_patch text from shell_command arguments (Codex SDK 0.144.x shape).
 * The SDK persists file edits as function_call name=shell_command with arguments JSON like
 *   {"command": ["apply_patch", "*** Begin Patch\n..."]}   (argv array, patch in a later entry)
 *   {"command": "apply_patch <<'EOF'\n*** Begin Patch\n..."} (string form)
 *   {"cmd": "apply_patch ...*** Begin Patch\n..."}           (cmd-string variant)
 * Returns '' when the arguments are unparseable or contain no Begin/End Patch markers.
 */
export function extractPatchFromShellCommand(argumentsJson) {
  if (typeof argumentsJson !== 'string' || !argumentsJson) {
    return '';
  }
  let args;
  try {
    args = JSON.parse(argumentsJson);
  } catch {
    return '';
  }
  if (!args || typeof args !== 'object') {
    return '';
  }

  const command = args.command ?? args.cmd;
  if (Array.isArray(command)) {
    // argv form: the patch text is the argv entry carrying the patch markers
    // (normally command[1] right after 'apply_patch', but tolerate wrappers like bash -lc).
    for (const entry of command) {
      if (typeof entry !== 'string' || entry === 'apply_patch') continue;
      if (entry.includes('*** Begin Patch')) {
        return extractPatchFromExecCommand(entry);
      }
    }
    return '';
  }
  if (typeof command === 'string') {
    return extractPatchFromExecCommand(command);
  }
  return '';
}

/**
 * Extracts apply_patch text from a response_item payload.
 * Supports function_call(exec_command/shell_command/apply_patch) and custom_tool_call(apply_patch).
 */
export function extractPatchFromResponseItemPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const payloadType = payload.type;
  const name = payload.name;

  if (payloadType === 'custom_tool_call' && name === 'apply_patch') {
    if (typeof payload.input === 'string') {
      return payload.input;
    }
    if (payload.input && typeof payload.input === 'object') {
      const patch = payload.input.patch ?? payload.input.input;
      return typeof patch === 'string' ? patch : '';
    }
    return '';
  }

  if (payloadType !== 'function_call') {
    return '';
  }

  if (name === 'apply_patch') {
    if (typeof payload.arguments === 'string') {
      try {
        const args = JSON.parse(payload.arguments);
        const patch = args?.patch ?? args?.input;
        return typeof patch === 'string' ? patch : '';
      } catch {
        return '';
      }
    }
    return '';
  }

  if (name === 'shell_command') {
    return extractPatchFromShellCommand(payload.arguments);
  }

  if (name !== 'exec_command' || typeof payload.arguments !== 'string') {
    return '';
  }

  try {
    const args = JSON.parse(payload.arguments);
    return extractPatchFromExecCommand(args?.cmd);
  } catch {
    return '';
  }
}

/**
 * Parses apply_patch text into reusable edit operations.
 */
export function parseApplyPatchToOperations(patchText) {
  if (typeof patchText !== 'string' || !patchText.trim()) {
    return [];
  }

  const lines = patchText.split('\n');
  const operations = [];

  let currentPath = null;
  let currentKind = null; // add | update | delete
  let currentHunkHeader = null;
  let oldLines = [];
  let newLines = [];
  let addFileLines = [];

  const flushUpdate = () => {
    if (!currentPath || currentKind !== 'update') return;
    const oldString = oldLines.join('\n');
    const newString = newLines.join('\n');
    if (oldString === newString) return;

    let startLine;
    let endLine;
    if (currentHunkHeader) {
      const oldCount = currentHunkHeader.oldCount;
      const newCount = currentHunkHeader.newCount;
      startLine = oldCount > 0 ? currentHunkHeader.oldStart : currentHunkHeader.newStart;
      const effectiveCount = oldCount > 0 ? oldCount : newCount;
      if (effectiveCount > 1) {
        endLine = startLine + effectiveCount - 1;
      }
    }

    operations.push({
      filePath: currentPath,
      kind: currentKind,
      oldString,
      newString,
      toolName: 'edit',
      startLine,
      endLine,
    });
  };

  const flushAdd = () => {
    if (!currentPath || currentKind !== 'add') return;
    operations.push({
      filePath: currentPath,
      kind: currentKind,
      oldString: '',
      newString: addFileLines.join('\n'),
      toolName: 'write'
    });
  };

  for (const rawLine of lines) {
    const line = rawLine ?? '';

    if (line.startsWith('*** Update File: ')) {
      flushUpdate();
      flushAdd();
      currentPath = line.slice('*** Update File: '.length).trim();
      currentKind = 'update';
      currentHunkHeader = null;
      oldLines = [];
      newLines = [];
      addFileLines = [];
      continue;
    }

    if (line.startsWith('*** Add File: ')) {
      flushUpdate();
      flushAdd();
      currentPath = line.slice('*** Add File: '.length).trim();
      currentKind = 'add';
      currentHunkHeader = null;
      oldLines = [];
      newLines = [];
      addFileLines = [];
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      flushUpdate();
      flushAdd();
      currentPath = line.slice('*** Delete File: '.length).trim();
      currentKind = 'delete';
      currentHunkHeader = null;
      oldLines = [];
      newLines = [];
      addFileLines = [];
      continue;
    }

    if (line.startsWith('*** Move to: ')) {
      const movedPath = line.slice('*** Move to: '.length).trim();
      if (movedPath) {
        currentPath = movedPath;
      }
      continue;
    }

    if (line.startsWith('*** End Patch')) {
      flushUpdate();
      flushAdd();
      currentPath = null;
      currentKind = null;
      currentHunkHeader = null;
      oldLines = [];
      newLines = [];
      addFileLines = [];
      continue;
    }

    if (!currentPath || !currentKind) {
      continue;
    }

    if (currentKind === 'delete') {
      continue;
    }

    if (currentKind === 'add') {
      if (line.startsWith('+')) {
        addFileLines.push(line.slice(1));
      }
      continue;
    }

    // update
    if (line.startsWith('@@')) {
      flushUpdate();
      currentHunkHeader = parseHunkHeader(line);
      oldLines = [];
      newLines = [];
      continue;
    }

    if (line === '\\ No newline at end of file') {
      continue;
    }

    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      const content = line.slice(1);
      oldLines.push(content);
      newLines.push(content);
    }
  }

  flushUpdate();
  flushAdd();

  return operations;
}
