/**
 * Per-message chat mode for the Claude provider.
 *
 * The webview may tag each claude.send / claude.sendWithAttachments request with
 * a `chatMode` field that adjusts behavior for that single query only — nothing
 * is persisted beyond the existing per-request mechanisms (SDK options,
 * systemPrompt append, permission mode reconciliation).
 *
 * Modes:
 * - agent    (default) no change
 * - ask      read-only Q&A: file-mutation tools are disallowed + read-only prompt
 * - plan     maps to the SDK's native plan permission mode for this query
 * - debug    appends a debugging-expert workflow prompt
 * - multitask appends a prompt steering the model toward parallel Task subagents
 */

const CHAT_MODES = Object.freeze(['agent', 'ask', 'plan', 'debug', 'multitask']);
const VALID_CHAT_MODES = new Set(CHAT_MODES);

// File-mutation tools blocked in ask mode via the SDK's disallowedTools option.
const ASK_MODE_DISALLOWED_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const ASK_MODE_PROMPT = `You are in read-only Q&A mode for this message.
Answer the user's question directly using read-only exploration only.
Do NOT create, modify, or delete any files, and do not run commands that change
project or system state. The Edit, Write, MultiEdit and NotebookEdit tools are
unavailable in this mode.
If the request requires changes, explain what you would change and why, and
provide the exact code or commands for the user to apply themselves.`;

const DEBUG_MODE_PROMPT = `You are in debugging mode for this message. Work as a debugging expert:
1. Reproduce: restate the symptom and reproduce or locate it in code/logs.
2. Isolate: narrow the failing path with targeted reads and instrumentation.
3. Root cause: identify the precise cause with evidence before changing anything.
4. Minimal fix: apply the smallest change that fixes the root cause.
5. Verify: run the relevant test or repro to confirm the fix and no regressions.
Keep the investigation focused; avoid unrelated refactors.`;

const MULTITASK_MODE_PROMPT = `You are in multitask mode for this message.
First decompose the request into independent work items.
For items that are independent of each other, launch parallel Task subagents —
one per item — instead of working serially.
Keep shared or coupled work in the main thread, then integrate the subagent
results and report a concise summary.
Do not spawn subagents for trivial steps or when tasks depend on each other.`;

export {
  CHAT_MODES,
  VALID_CHAT_MODES,
  ASK_MODE_DISALLOWED_TOOLS
};

export function normalizeChatMode(chatMode) {
  if (typeof chatMode !== 'string') return 'agent';
  const normalized = chatMode.trim();
  if (normalized === '') return 'agent';
  if (VALID_CHAT_MODES.has(normalized)) return normalized;
  console.warn('[DAEMON] Unknown chat mode, falling back to agent:', chatMode);
  return 'agent';
}

/**
 * Build the systemPrompt append fragment for a chat mode, or null when the
 * mode needs no prompt (agent, plan). The caller composes this WITH the
 * existing systemPrompt append — it must never replace it.
 */
export function buildChatModePromptAppend(chatMode) {
  switch (normalizeChatMode(chatMode)) {
    case 'ask':
      return ASK_MODE_PROMPT;
    case 'debug':
      return DEBUG_MODE_PROMPT;
    case 'multitask':
      return MULTITASK_MODE_PROMPT;
    default:
      return null;
  }
}
