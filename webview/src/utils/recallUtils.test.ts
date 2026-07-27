import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import {
  countFileChangesAfter,
  extractUserMessageText,
  findRecallIndex,
  getMessageUuid,
} from './recallUtils';

function userMessage(uuid: string, content: string): ClaudeMessage {
  return {
    type: 'user',
    content,
    timestamp: '2026-07-27T10:00:00Z',
    raw: { type: 'user', uuid, message: { content } },
  };
}

function assistantWithTools(uuid: string, tools: Array<{ name: string; input?: Record<string, unknown> }>): ClaudeMessage {
  return {
    type: 'assistant',
    timestamp: '2026-07-27T10:01:00Z',
    raw: {
      type: 'assistant',
      uuid,
      message: {
        content: tools.map(tool => ({ type: 'tool_use', name: tool.name, input: tool.input ?? {} })),
      },
    },
  };
}

describe('getMessageUuid', () => {
  it('reads uuid from object raw', () => {
    expect(getMessageUuid(userMessage('u1', 'hi'))).toBe('u1');
  });

  it('returns null for string or missing raw', () => {
    expect(getMessageUuid({ type: 'user', content: 'x', raw: 'raw-string' })).toBeNull();
    expect(getMessageUuid({ type: 'user', content: 'x' })).toBeNull();
  });
});

describe('findRecallIndex', () => {
  it('locates by uuid and returns -1 when absent', () => {
    const messages = [userMessage('u1', 'a'), userMessage('u2', 'b')];
    expect(findRecallIndex(messages, 'u2')).toBe(1);
    expect(findRecallIndex(messages, 'nope')).toBe(-1);
  });
});

describe('extractUserMessageText', () => {
  it('prefers the plain content field', () => {
    expect(extractUserMessageText(userMessage('u1', 'hello'))).toBe('hello');
  });

  it('falls back to raw string content', () => {
    const message: ClaudeMessage = {
      type: 'user',
      content: '',
      raw: { uuid: 'u1', message: { content: 'raw text' } },
    };
    expect(extractUserMessageText(message)).toBe('raw text');
  });

  it('joins raw text blocks and ignores tool_result blocks', () => {
    const message: ClaudeMessage = {
      type: 'user',
      content: '',
      raw: {
        uuid: 'u1',
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool_result', content: 'ignored' },
            { type: 'text', text: 'second' },
          ],
        },
      },
    };
    expect(extractUserMessageText(message)).toBe('first\nsecond');
  });
});

describe('countFileChangesAfter', () => {
  it('counts distinct paths of file-modifying tools after the index only', () => {
    const messages = [
      userMessage('u1', 'start'),
      assistantWithTools('a1', [
        { name: 'Write', input: { file_path: '/p/a.ts' } },
        { name: 'Edit', input: { file_path: '/p/a.ts' } },
      ]),
      userMessage('u2', 'more'),
      assistantWithTools('a2', [
        { name: 'Edit', input: { file_path: '/p/b.ts' } },
        { name: 'Read', input: { file_path: '/p/c.ts' } },
        { name: 'Bash', input: { command: 'rm /p/d.ts' } },
      ]),
    ];

    // After u2 (index 2): only /p/b.ts.
    expect(countFileChangesAfter(messages, 2)).toBe(1);
    // After u1 (index 0): /p/a.ts and /p/b.ts (deduped a.ts).
    expect(countFileChangesAfter(messages, 0)).toBe(2);
  });

  it('returns 0 when nothing was modified', () => {
    const messages = [userMessage('u1', 'hi'), assistantWithTools('a1', [{ name: 'Read' }])];
    expect(countFileChangesAfter(messages, 0)).toBe(0);
  });
});
