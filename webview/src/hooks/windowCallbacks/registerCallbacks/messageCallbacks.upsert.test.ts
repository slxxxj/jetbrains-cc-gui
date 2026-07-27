/**
 * messageCallbacks.upsert.test.ts
 *
 * Registration-level coverage for window.upsertMessage — the incremental
 * streaming channel:
 * - applies a single-message upsert to the streaming bubble (structural
 *   blocks land without a full-list replace);
 * - enforces the shared __minAcceptedUpdateSequence barrier;
 * - is suppressed during session transitions;
 * - feeds the stall watchdog (__lastStreamActivityAt);
 * - keeps longer streamed content over a shorter backend upsert.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerMessageCallbacks } from './messageCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { StreamingHint } from '../../../contexts/MessagesContext';
import type { ClaudeMessage } from '../../../types';

type Ref<T> = { current: T };
const ref = <T,>(value: T): Ref<T> => ({ current: value });

const findLastAssistantIndex = (msgs: ClaudeMessage[]): number =>
  msgs.reduce((acc, m, i) => (m.type === 'assistant' ? i : acc), -1);

/** Realistic extractRawBlocks: reads blocks from raw.message.content / raw.content. */
const realExtractRawBlocks = (raw: ClaudeMessage['raw']): Record<string, unknown>[] => {
  if (!raw || typeof raw !== 'object') return [];
  const holder = raw as { message?: { content?: unknown }; content?: unknown };
  const content = holder.message?.content ?? holder.content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
};

function createHarness(
  initialMessages: ClaudeMessage[],
  overrides?: {
    extractRawBlocks?: (raw: ClaudeMessage['raw']) => Record<string, unknown>[];
  },
) {
  let messages = [...initialMessages];
  let streamingHint: StreamingHint | null = null;

  const refs = {
    streamingContentRef: ref(''),
    isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false),
    streamingMessageIndexRef: ref(-1),
    streamingTurnIdRef: ref(-1),
    currentProviderRef: ref('claude'),
    userPausedRef: ref(false),
    isUserAtBottomRef: ref(true),
    messagesContainerRef: ref<HTMLDivElement | null>(null),
    suppressNextStatusToastRef: ref(false),
  };

  const options = {
    ...refs,
    addToast: () => {},
    setMessages: (updater: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    },
    setStatus: () => {},
    setLoading: () => {},
    setLoadingStartTime: () => {},
    setIsThinking: () => {},
    setStreamingHint: (
      updater: StreamingHint | null | ((prev: StreamingHint | null) => StreamingHint | null),
    ) => {
      streamingHint = typeof updater === 'function' ? updater(streamingHint) : updater;
    },
    setHistoryData: () => {},
    findLastAssistantIndex,
    extractRawBlocks: overrides?.extractRawBlocks ?? (() => []),
    patchAssistantForStreaming: (message: ClaudeMessage) => ({ ...message, isStreaming: true }),
    updateContextUsageData: () => false,
    closeContextUsageDialog: () => false,
  } as unknown as UseWindowCallbacksOptions;

  registerMessageCallbacks(options, () => {});
  return {
    refs,
    getMessages: () => messages,
    getStreamingHint: () => streamingHint,
    setStreamingHintState: (hint: StreamingHint | null) => {
      streamingHint = hint;
    },
  };
}

const streamingBubble = (content: string, turnId: number): ClaudeMessage => ({
  type: 'assistant',
  content,
  isStreaming: true,
  __turnId: turnId,
  timestamp: '2024-01-01T00:00:00Z',
});

describe('window.upsertMessage', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    window.__minAcceptedUpdateSequence = undefined;
    // The stall watchdog (started by onStreamStart) initializes this to a
    // timestamp; upsertMessage only bumps an already-initialized watchdog,
    // mirroring updateMessages.
    window.__lastStreamActivityAt = 0;
    window.__deniedToolIds = undefined;
  });

  it('upserts structural blocks into the streaming bubble without touching other messages', () => {
    const userMsg: ClaudeMessage = { type: 'user', content: 'q', timestamp: '2024-01-01T00:00:00Z' };
    const { refs, getMessages } = createHarness([userMsg, streamingBubble('working', 4)]);
    refs.isStreamingRef.current = true;
    refs.streamingTurnIdRef.current = 4;
    refs.streamingMessageIndexRef.current = 1;

    const upsert = [{
      type: 'assistant',
      content: 'working',
      timestamp: '2024-06-01T00:00:00Z',
      raw: { message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }] } },
    }];
    window.upsertMessage!(JSON.stringify(upsert), '10');

    const messages = getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(userMsg); // untouched
    expect(messages[1].__turnId).toBe(4);
    expect(messages[1].isStreaming).toBe(true);
    const raw = messages[1].raw as { message: { content: Array<{ type: string }> } };
    expect(raw.message.content[0].type).toBe('tool_use');
    // Sequence barrier advanced.
    expect(window.__minAcceptedUpdateSequence).toBe(10);
    // Stall watchdog fed.
    expect(window.__lastStreamActivityAt).toBeGreaterThan(0);
  });

  it('rejects upserts below the accepted sequence barrier', () => {
    const { refs, getMessages } = createHarness([streamingBubble('working', 1)]);
    refs.isStreamingRef.current = true;
    refs.streamingTurnIdRef.current = 1;
    refs.streamingMessageIndexRef.current = 0;
    window.__minAcceptedUpdateSequence = 20;

    const upsert = [{ type: 'assistant', content: 'stale' }];
    window.upsertMessage!(JSON.stringify(upsert), '10');

    expect(getMessages()[0].content).toBe('working');
    expect(window.__minAcceptedUpdateSequence).toBe(20);
  });

  it('is suppressed while a session transition is in progress', () => {
    const { refs, getMessages } = createHarness([streamingBubble('working', 1)]);
    refs.isStreamingRef.current = true;
    refs.streamingTurnIdRef.current = 1;
    window.__sessionTransitioning = true;

    window.upsertMessage!(JSON.stringify([{ type: 'assistant', content: 'new' }]), '1');

    expect(getMessages()[0].content).toBe('working');
  });

  it('keeps the longer streamed content when the upsert carries a shorter one', () => {
    // The bubble's raw text block already reflects the delta channel's progress
    // (a previous upsert/delta sync placed it there); the new upsert lags behind.
    const bubble: ClaudeMessage = {
      ...streamingBubble('Hello world', 2),
      raw: { message: { content: [{ type: 'text', text: 'Hello world' }] } },
    };
    const { refs, getMessages } = createHarness([bubble]);
    refs.isStreamingRef.current = true;
    refs.streamingTurnIdRef.current = 2;
    refs.streamingMessageIndexRef.current = 0;
    refs.streamingContentRef.current = 'Hello world';

    // Backend upsert lags behind the delta channel (shorter text).
    const upsert = [{
      type: 'assistant',
      content: 'Hello',
      raw: { message: { content: [{ type: 'text', text: 'Hello' }] } },
    }];
    window.upsertMessage!(JSON.stringify(upsert), '3');

    const messages = getMessages();
    expect(messages[0].content).toBe('Hello world');
    // The raw text block is protected the same way (longer frontend copy wins).
    const raw = messages[0].raw as { message: { content: Array<{ text?: string }> } };
    expect(raw.message.content[0].text).toBe('Hello world');
  });

  it('appends a tool_result message and dedups a repeated one', () => {
    const { refs, getMessages } = createHarness([streamingBubble('working', 1)]);
    refs.isStreamingRef.current = true;
    refs.streamingTurnIdRef.current = 1;
    refs.streamingMessageIndexRef.current = 0;

    const toolResult = [{
      type: 'user',
      content: '[tool_result]',
      raw: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] } },
    }];
    window.upsertMessage!(JSON.stringify(toolResult), '5');
    expect(getMessages()).toHaveLength(2);

    // Same tool_use_id upserted again (next throttle window): no duplicate card.
    window.upsertMessage!(JSON.stringify(toolResult), '6');
    expect(getMessages()).toHaveLength(2);
  });

  it('ignores malformed JSON payloads without crashing', () => {
    const { getMessages } = createHarness([streamingBubble('working', 1)]);
    window.upsertMessage!('{not json', '7');
    expect(getMessages()).toHaveLength(1);
  });

  it('clears a tool_preparing hint when an upsert carries the tool_use card', () => {
    const { refs, getStreamingHint, setStreamingHintState } = createHarness(
      [streamingBubble('working', 1)],
      { extractRawBlocks: realExtractRawBlocks },
    );
    refs.isStreamingRef.current = true;
    refs.streamingTurnIdRef.current = 1;
    refs.streamingMessageIndexRef.current = 0;
    setStreamingHintState({ kind: 'tool_preparing', toolName: 'Write' });

    const toolUseUpsert = [{
      type: 'assistant',
      content: '',
      raw: { message: { content: [{ type: 'tool_use', id: 'tu-9', name: 'Write', input: {} }] } },
    }];
    window.upsertMessage!(JSON.stringify(toolUseUpsert), '5');

    expect(getStreamingHint()).toBeNull();
  });

  it('keeps the tool_preparing hint when the upsert has no tool_use block', () => {
    const { refs, getStreamingHint, setStreamingHintState } = createHarness(
      [streamingBubble('working', 1)],
      { extractRawBlocks: realExtractRawBlocks },
    );
    refs.isStreamingRef.current = true;
    refs.streamingTurnIdRef.current = 1;
    refs.streamingMessageIndexRef.current = 0;
    setStreamingHintState({ kind: 'tool_preparing', toolName: 'Write' });

    const thinkingUpsert = [{
      type: 'assistant',
      content: '',
      raw: { message: { content: [{ type: 'thinking', thinking: 'still reasoning' }] } },
    }];
    window.upsertMessage!(JSON.stringify(thinkingUpsert), '5');

    expect(getStreamingHint()).toEqual({ kind: 'tool_preparing', toolName: 'Write' });
  });

  it('does NOT clear a compacting hint on a tool_use upsert (different hint kind)', () => {
    const { refs, getStreamingHint, setStreamingHintState } = createHarness(
      [streamingBubble('working', 1)],
      { extractRawBlocks: realExtractRawBlocks },
    );
    refs.isStreamingRef.current = true;
    refs.streamingTurnIdRef.current = 1;
    refs.streamingMessageIndexRef.current = 0;
    setStreamingHintState({ kind: 'compacting' });

    const toolUseUpsert = [{
      type: 'assistant',
      content: '',
      raw: { message: { content: [{ type: 'tool_use', id: 'tu-9', name: 'Write', input: {} }] } },
    }];
    window.upsertMessage!(JSON.stringify(toolUseUpsert), '5');

    expect(getStreamingHint()).toEqual({ kind: 'compacting' });
  });
});
