import type { ClaudeMessage } from '../types';
import { FILE_MODIFY_TOOL_NAMES, isToolName } from './toolConstants';

/**
 * Helpers for the message-level recall (撤回) feature:
 * locating a message by its SDK uuid, extracting its text for input-box
 * restore, and estimating how many files were modified after it.
 */

/** Extract the SDK message uuid from a chat message, if present. */
export function getMessageUuid(message: ClaudeMessage): string | null {
  const raw = message.raw;
  if (!raw || typeof raw !== 'object') return null;
  const uuid = (raw as Record<string, unknown>).uuid;
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : null;
}

/** Index of the message carrying the given uuid, or -1. */
export function findRecallIndex(messages: ClaudeMessage[], uuid: string): number {
  return messages.findIndex(m => getMessageUuid(m) === uuid);
}

interface RawContentCarrier {
  content?: unknown;
  message?: { content?: unknown };
}

function rawContentBlocks(raw: ClaudeMessage['raw']): unknown[] | string | null {
  if (!raw || typeof raw !== 'object') return null;
  const carrier = raw as RawContentCarrier;
  return (carrier.message?.content ?? carrier.content ?? null) as unknown[] | string | null;
}

/**
 * Best-effort plain text of a user message, used both for the confirm-dialog
 * preview and for restoring the text into the input box.
 */
export function extractUserMessageText(message: ClaudeMessage): string {
  if (message.content && message.content.trim()) {
    return message.content;
  }
  const content = rawContentBlocks(message.raw);
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text?: string } =>
        Boolean(block) && typeof block === 'object' && (block as { type?: string }).type === 'text')
      .map(block => block.text ?? '')
      .filter(text => text.length > 0)
      .join('\n');
  }
  return '';
}

/**
 * Count distinct file paths touched by file-modifying tool calls in the
 * messages AFTER fromIndex. This is an estimate shown in the confirm dialog;
 * the authoritative restore is done by the SDK checkpoint rewind.
 */
export function countFileChangesAfter(messages: ClaudeMessage[], fromIndex: number): number {
  const paths = new Set<string>();
  for (let i = fromIndex + 1; i < messages.length; i++) {
    const content = rawContentBlocks(messages[i].raw);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
      if (b.type !== 'tool_use' || !isToolName(b.name, FILE_MODIFY_TOOL_NAMES)) continue;
      const filePath = b.input?.file_path ?? b.input?.filePath ?? b.input?.path;
      if (typeof filePath === 'string' && filePath.length > 0) {
        paths.add(filePath);
      }
    }
  }
  return paths.size;
}
