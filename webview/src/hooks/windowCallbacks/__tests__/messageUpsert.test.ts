/**
 * messageUpsert.test.ts
 *
 * Pure-function coverage for upsertMessagesIntoList — the incremental
 * streaming channel reducer.  Matching order under test:
 *   1. streaming assistant bubble (turn id → tracked index → uuid),
 *   2. uuid identity,
 *   3. tool_result append with tool_use_id dedup,
 *   4. generic tail refresh / append.
 */
import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../../../types';
import { getRawUuid, getToolResultIds, upsertMessagesIntoList } from '../messageSync';
import type { UpsertStreamingContext } from '../messageSync';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMsg = (
  type: ClaudeMessage['type'],
  content: string,
  extra?: Partial<ClaudeMessage>,
): ClaudeMessage => ({
  type,
  content,
  timestamp: new Date().toISOString(),
  ...extra,
});

const streamingCtx = (overrides?: Partial<UpsertStreamingContext>): UpsertStreamingContext => ({
  isStreaming: true,
  streamingTurnId: 1,
  streamingMessageIndex: -1,
  ...overrides,
});

const idleCtx = (overrides?: Partial<UpsertStreamingContext>): UpsertStreamingContext => ({
  isStreaming: false,
  streamingTurnId: -1,
  streamingMessageIndex: -1,
  ...overrides,
});

const toolResultMsg = (toolUseId: string, extra?: Partial<ClaudeMessage>): ClaudeMessage =>
  makeMsg('user', '[tool_result]', {
    raw: {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
    } as ClaudeMessage['raw'],
    ...extra,
  });

// ---------------------------------------------------------------------------
// getToolResultIds
// ---------------------------------------------------------------------------

describe('getToolResultIds', () => {
  it('extracts tool_use_id values from raw.message.content blocks', () => {
    expect(getToolResultIds(toolResultMsg('tu-1'))).toEqual(['tu-1']);
  });

  it('returns [] for messages without raw or tool_result blocks', () => {
    expect(getToolResultIds(makeMsg('assistant', 'hi'))).toEqual([]);
    expect(getToolResultIds(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// upsertMessagesIntoList — uuid identity
// ---------------------------------------------------------------------------

describe('upsertMessagesIntoList · uuid identity', () => {
  it('replaces the message with the same uuid in place, preserving identity fields', () => {
    const prev = [
      makeMsg('user', 'q', { raw: { uuid: 'u-1' } as ClaudeMessage['raw'], timestamp: '2024-01-01T00:00:00Z' }),
      makeMsg('assistant', 'old', {
        raw: { uuid: 'a-1' } as ClaudeMessage['raw'],
        timestamp: '2024-01-01T00:00:01Z',
        durationMs: 1234,
      }),
    ];
    const incoming = makeMsg('assistant', 'new content', {
      raw: { uuid: 'a-1' } as ClaudeMessage['raw'],
      timestamp: '2024-06-01T12:00:00Z',
    });

    const { list } = upsertMessagesIntoList(prev, [incoming], idleCtx());

    expect(list).toHaveLength(2);
    expect(list[1].content).toBe('new content');
    // preserveMessageIdentity keeps the stable timestamp; durationMs survives.
    expect(list[1].timestamp).toBe('2024-01-01T00:00:01Z');
    expect(list[1].durationMs).toBe(1234);
    // The other message is untouched (same reference).
    expect(list[0]).toBe(prev[0]);
  });

  it('appends when the uuid is not present in the list', () => {
    const prev = [makeMsg('user', 'q')];
    const incoming = makeMsg('assistant', 'answer', { raw: { uuid: 'a-9' } as ClaudeMessage['raw'] });

    const { list } = upsertMessagesIntoList(prev, [incoming], idleCtx());

    expect(list).toHaveLength(2);
    expect(list[1]).toBe(incoming);
  });
});

// ---------------------------------------------------------------------------
// upsertMessagesIntoList — streaming assistant bubble
// ---------------------------------------------------------------------------

describe('upsertMessagesIntoList · streaming assistant bubble', () => {
  it('matches the streaming bubble by turn id and keeps streaming markers', () => {
    const bubble = makeMsg('assistant', 'partial', {
      isStreaming: true,
      __turnId: 3,
      timestamp: '2024-01-01T00:00:00Z',
    });
    const prev = [makeMsg('user', 'q'), bubble];
    // Backend assistant carries a uuid the frontend bubble does not have.
    const incoming = makeMsg('assistant', 'partial', {
      raw: {
        uuid: 'a-1',
        message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }] },
      } as ClaudeMessage['raw'],
      timestamp: '2024-06-01T00:00:00Z',
    });

    const { list, streamingMessageIndex } = upsertMessagesIntoList(
      prev,
      [incoming],
      streamingCtx({ streamingTurnId: 3 }),
    );

    expect(list).toHaveLength(2);
    expect(list[1].__turnId).toBe(3);
    expect(list[1].isStreaming).toBe(true);
    // The tool_use block landed on the bubble.
    expect(getRawUuid(list[1])).toBeUndefined(); // identity stability: uuid stripped
    expect((list[1].raw as { message: { content: unknown[] } }).message.content).toHaveLength(1);
    expect(streamingMessageIndex).toBe(1);
  });

  it('falls back to the tracked streamingMessageIndex when turn id does not match', () => {
    const bubble = makeMsg('assistant', 'partial', { isStreaming: true });
    const prev = [makeMsg('user', 'q'), bubble];
    const incoming = makeMsg('assistant', 'partial+blocks', {
      raw: { message: { content: [{ type: 'thinking', thinking: 'hmm' }] } } as ClaudeMessage['raw'],
    });

    const { list } = upsertMessagesIntoList(
      prev,
      [incoming],
      streamingCtx({ streamingTurnId: 9, streamingMessageIndex: 1 }),
    );

    expect(list).toHaveLength(2);
    expect(list[1].content).toBe('partial+blocks');
    expect(list[1].isStreaming).toBe(true);
  });

  it('appends and adopts the bubble when the list has no streaming assistant', () => {
    const prev = [makeMsg('user', 'q')];
    const incoming = makeMsg('assistant', 'answer');

    const { list, streamingMessageIndex } = upsertMessagesIntoList(
      prev,
      [incoming],
      streamingCtx({ streamingTurnId: 5 }),
    );

    expect(list).toHaveLength(2);
    expect(list[1].__turnId).toBe(5);
    expect(list[1].isStreaming).toBe(true);
    expect(streamingMessageIndex).toBe(1);
  });

  it('matches by uuid inside the streaming branch when no bubble identity fits', () => {
    // A previously-upserted assistant that already carries the uuid (e.g. after
    // the streaming markers were dropped by a race) is still found by uuid.
    const existing = makeMsg('assistant', 'v1', { raw: { uuid: 'a-2' } as ClaudeMessage['raw'] });
    const prev = [makeMsg('user', 'q'), existing];
    const incoming = makeMsg('assistant', 'v2', { raw: { uuid: 'a-2' } as ClaudeMessage['raw'] });

    const { list } = upsertMessagesIntoList(prev, [incoming], streamingCtx({ streamingTurnId: 7 }));

    expect(list).toHaveLength(2);
    expect(list[1].content).toBe('v2');
  });
});

// ---------------------------------------------------------------------------
// upsertMessagesIntoList — tool_result messages
// ---------------------------------------------------------------------------

describe('upsertMessagesIntoList · tool_result', () => {
  it('appends a no-uuid tool_result message', () => {
    const prev = [makeMsg('assistant', 'working')];
    const { list } = upsertMessagesIntoList(prev, [toolResultMsg('tu-1')], streamingCtx());

    expect(list).toHaveLength(2);
    expect(list[1].content).toBe('[tool_result]');
  });

  it('skips a tool_result whose tool_use_id is already present (dedup)', () => {
    const prev = [makeMsg('assistant', 'working'), toolResultMsg('tu-1')];
    const duplicate = toolResultMsg('tu-1');

    const { list } = upsertMessagesIntoList(prev, [duplicate], streamingCtx());

    expect(list).toHaveLength(2);
    expect(list).toBe(prev); // no-op keeps the same list reference
  });

  it('prefers uuid identity for SDK-echoed tool_result user messages', () => {
    const sdkEcho = toolResultMsg('tu-2', { raw: { uuid: 'u-1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu-2', content: 'ok' },
    ] } } as ClaudeMessage['raw'] });
    const prev = [makeMsg('assistant', 'working')];

    const { list } = upsertMessagesIntoList(prev, [sdkEcho], streamingCtx());

    expect(list).toHaveLength(2);
    expect(getRawUuid(list[1])).toBe('u-1');
  });
});

// ---------------------------------------------------------------------------
// upsertMessagesIntoList — generic fallback & batching
// ---------------------------------------------------------------------------

describe('upsertMessagesIntoList · generic fallback & batching', () => {
  it('refreshes the tail entry when type and content match', () => {
    const prev = [makeMsg('user', 'q'), makeMsg('assistant', 'same')];
    const incoming = makeMsg('assistant', 'same', {
      raw: { message: { content: [{ type: 'text', text: 'same' }] } } as ClaudeMessage['raw'],
    });

    const { list } = upsertMessagesIntoList(prev, [incoming], idleCtx());

    expect(list).toHaveLength(2);
    expect(list[1]).toBe(incoming);
  });

  it('appends a no-uuid message that does not match the tail', () => {
    const prev = [makeMsg('user', 'q')];
    const incoming = makeMsg('assistant', 'brand new');

    const { list } = upsertMessagesIntoList(prev, [incoming], idleCtx());

    expect(list).toHaveLength(2);
  });

  it('applies a batched window in order (later upserts see earlier results)', () => {
    const prev = [makeMsg('user', 'q'), makeMsg('assistant', 'streaming', { isStreaming: true, __turnId: 2 })];
    const window = [
      makeMsg('assistant', 'streaming', {
        raw: { message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }] } } as ClaudeMessage['raw'],
      }),
      toolResultMsg('tu-1'),
      toolResultMsg('tu-1'), // duplicate in the same window must dedup
    ];

    const { list } = upsertMessagesIntoList(prev, window, streamingCtx({ streamingTurnId: 2 }));

    expect(list).toHaveLength(3);
    expect(list[1].__turnId).toBe(2);
    expect(getToolResultIds(list[2])).toEqual(['tu-1']);
  });

  it('ignores malformed entries and returns the input list reference when nothing changed', () => {
    const prev = [makeMsg('user', 'q'), toolResultMsg('tu-1')];
    const { list } = upsertMessagesIntoList(
      prev,
      [null as unknown as ClaudeMessage, toolResultMsg('tu-1')],
      streamingCtx(),
    );
    expect(list).toBe(prev);
  });
});

// ---------------------------------------------------------------------------
// upsertMessagesIntoList — Codex-shaped messages (no uuid anywhere)
// ---------------------------------------------------------------------------

describe('upsertMessagesIntoList · codex shapes', () => {
  // Codex raw messages never carry a uuid: assistants look like
  // {type:'assistant', message:{role, content:[...]}} and tool_result user
  // messages carry a call_id-derived tool_use_id.
  const codexAssistant = (text: string, extra?: Partial<ClaudeMessage>): ClaudeMessage =>
    makeMsg('assistant', text, {
      raw: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      } as ClaudeMessage['raw'],
      ...extra,
    });

  it('matches the uuid-less codex assistant snapshot against the streaming bubble', () => {
    const prev = [
      makeMsg('user', 'q'),
      makeMsg('assistant', '', { isStreaming: true, __turnId: 7 }),
    ];

    const { list, streamingMessageIndex } = upsertMessagesIntoList(
      prev,
      [codexAssistant('full text')],
      streamingCtx({ streamingTurnId: 7 }),
    );

    expect(list).toHaveLength(2);
    expect(list[1].content).toBe('full text');
    // Streaming markers survive the in-place replacement.
    expect(list[1].isStreaming).toBe(true);
    expect(list[1].__turnId).toBe(7);
    expect(streamingMessageIndex).toBe(1);
  });

  it('appends then dedups codex tool_result user messages by call_id-derived tool_use_id', () => {
    const codexResult = toolResultMsg('call_abc123');
    const prev = [makeMsg('user', 'q'), makeMsg('assistant', '', { isStreaming: true, __turnId: 3 })];

    const appended = upsertMessagesIntoList(prev, [codexResult], streamingCtx({ streamingTurnId: 3 }));
    expect(appended.list).toHaveLength(3);
    expect(getToolResultIds(appended.list[2])).toEqual(['call_abc123']);

    const deduped = upsertMessagesIntoList(appended.list, [toolResultMsg('call_abc123')], streamingCtx({ streamingTurnId: 3 }));
    expect(deduped.list).toBe(appended.list);
  });

  it('does not let a uuid-less codex assistant upsert clobber the tool_result tail', () => {
    // Window order: tool_use assistant merge, then its tool_result.  The
    // assistant upsert must hit the streaming bubble (case 1), not the tail
    // (case 4), so the appended tool_result is never overwritten.
    const prev = [
      makeMsg('user', 'q'),
      makeMsg('assistant', '', { isStreaming: true, __turnId: 5 }),
    ];
    const window = [
      codexAssistant('', {
        raw: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_9', name: 'Bash', input: {} }] },
        } as ClaudeMessage['raw'],
      }),
      toolResultMsg('call_9'),
    ];

    const { list } = upsertMessagesIntoList(prev, window, streamingCtx({ streamingTurnId: 5 }));

    expect(list).toHaveLength(3);
    expect(list[1].type).toBe('assistant');
    expect(list[2].type).toBe('user');
    expect(getToolResultIds(list[2])).toEqual(['call_9']);
  });
});
