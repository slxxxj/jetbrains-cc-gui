/**
 * streamingCallbacks.test.ts
 *
 * onStreamStart bubble routing:
 * - a still-streaming assistant from an OLDER turn (dropped onStreamEnd) is
 *   finalized and new deltas land on a fresh bubble;
 * - a replay start REUSES the last assistant bubble — the stale-bubble
 *   finalize must not hijack that path (it would strand the replayed turn's
 *   earlier content in a duplicate bubble);
 * - the normal path appends a fresh streaming bubble.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerStreamingCallbacks } from './streamingCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { StreamingHint } from '../../../contexts/MessagesContext';
import type { ClaudeMessage } from '../../../types';

type Ref<T> = { current: T };
const ref = <T,>(value: T): Ref<T> => ({ current: value });

function createHarness(initialMessages: ClaudeMessage[], turnIdCounter: number) {
  let messages = [...initialMessages];
  let streamingHint: StreamingHint | null = null;

  const refs = {
    streamingContentRef: ref(''),
    streamingThinkingRef: ref(''),
    isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false),
    autoExpandedThinkingKeysRef: ref(new Set<string>()),
    streamingMessageIndexRef: ref(-1),
    streamingTurnIdRef: ref(-1),
    turnIdCounterRef: ref(turnIdCounter),
    lastContentUpdateRef: ref(0),
    contentUpdateTimeoutRef: ref<number | null>(null),
    lastThinkingUpdateRef: ref(0),
    thinkingUpdateTimeoutRef: ref<number | null>(null),
    currentProviderRef: ref('claude'),
  };

  const options = {
    ...refs,
    setMessages: (updater: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    },
    setStreamingActive: () => {},
    setLoading: () => {},
    setLoadingStartTime: () => {},
    setIsThinking: () => {},
    setExpandedThinking: () => {},
    setStreamingHint: (
      updater: StreamingHint | null | ((prev: StreamingHint | null) => StreamingHint | null),
    ) => {
      streamingHint = typeof updater === 'function' ? updater(streamingHint) : updater;
    },
    getOrCreateStreamingAssistantIndex: () => -1,
    patchAssistantForStreaming: (message: ClaudeMessage) => message,
  } as unknown as UseWindowCallbacksOptions;

  registerStreamingCallbacks(options);
  return {
    refs,
    getMessages: () => messages,
    getStreamingHint: () => streamingHint,
    setStreamingHintState: (hint: StreamingHint | null) => {
      streamingHint = hint;
    },
  };
}

describe('onStreamStart bubble routing', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
  });

  afterEach(() => {
    // registerStreamingCallbacks starts a stall watchdog on stream start.
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
  });

  const olderTurnStreamingAssistant: ClaudeMessage = {
    type: 'assistant',
    content: 'partial answer from turn 1',
    isStreaming: true,
    __turnId: 1,
  };

  it('finalizes a still-streaming assistant from an older turn and opens a fresh bubble', () => {
    const { refs, getMessages } = createHarness(
      [{ type: 'user', content: 'q1' }, { ...olderTurnStreamingAssistant }],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    expect(messages).toHaveLength(3);
    // The orphaned bubble is closed with its content intact...
    expect(messages[1].isStreaming).toBe(false);
    expect(messages[1].content).toBe('partial answer from turn 1');
    // ...and the new turn streams into a fresh bubble.
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].isStreaming).toBe(true);
    expect(messages[2].content).toBe('');
    expect(messages[2].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(2);
  });

  it('replay start reuses the last assistant bubble even when it is a stale streaming one', () => {
    // Regression: the stale-bubble finalize must not run before the replay
    // branch. A replay re-delivers the last turn into the LAST bubble; adding
    // a fresh bubble here would duplicate the partial content on screen.
    const { refs, getMessages } = createHarness(
      [{ type: 'user', content: 'q1' }, { ...olderTurnStreamingAssistant }],
      1,
    );

    window.onStreamStart!('replay');

    const messages = getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1].isStreaming).toBe(true);
    expect(messages[1].content).toBe('partial answer from turn 1');
    expect(messages[1].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(1);
  });

  it('appends a fresh streaming bubble on the normal path (last assistant already finalized)', () => {
    const { refs, getMessages } = createHarness(
      [
        { type: 'user', content: 'q1' },
        { type: 'assistant', content: 'finished answer', isStreaming: false, __turnId: 1 },
      ],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[1].isStreaming).toBe(false);
    expect(messages[1].content).toBe('finished answer');
    expect(messages[2].isStreaming).toBe(true);
    expect(messages[2].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(2);
  });

  it('does not finalize history assistants without a __turnId', () => {
    // History messages loaded from JSONL have no __turnId; they are never
    // "streaming leftovers" of this webview instance and must be left as-is.
    const { getMessages } = createHarness(
      [{ type: 'assistant', content: 'history entry', isStreaming: true }],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].isStreaming).toBe(true);
    expect(messages[1].isStreaming).toBe(true);
    expect(messages[1].__turnId).toBe(2);
  });

  it('reuses an EMPTY older streaming bubble instead of leaving a blank ghost', () => {
    // Regression for duplicated/ghost bubbles: an empty streaming bubble from an
    // older turn (a redundant STREAM_START, or one with no deltas yet) must be
    // reused for the new turn — not finalized as a blank message with a fresh
    // bubble appended after it.
    const { refs, getMessages } = createHarness(
      [
        { type: 'user', content: 'q1' },
        { type: 'assistant', content: '', isStreaming: true, __turnId: 1 },
      ],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    // No extra bubble: the empty placeholder is reused for turn 2.
    expect(messages).toHaveLength(2);
    expect(messages[1].type).toBe('assistant');
    expect(messages[1].isStreaming).toBe(true);
    expect(messages[1].content).toBe('');
    expect(messages[1].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(1);
  });

  it('does not create a ghost bubble when onStreamStart fires twice with no deltas', () => {
    // Duplicate STREAM_START delivery: two starts back-to-back before any delta.
    // Must end with exactly one streaming bubble, not two.
    const { refs, getMessages } = createHarness(
      [{ type: 'user', content: 'q1' }],
      0,
    );

    window.onStreamStart!(); // turn 1 bubble (empty)
    window.onStreamStart!(); // duplicate — must reuse, not append

    const messages = getMessages();
    const assistantBubbles = messages.filter((m) => m.type === 'assistant');
    expect(assistantBubbles).toHaveLength(1);
    expect(assistantBubbles[0].isStreaming).toBe(true);
    expect(assistantBubbles[0].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(1);
  });
});

describe('onStreamEnd finalizes dangling tool_use when the turn never streamed', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    window.__deniedToolIds = undefined;
  });

  afterEach(() => {
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
    window.__deniedToolIds = undefined;
  });

  const assistantWithToolUse = (id: string): ClaudeMessage => ({
    type: 'assistant',
    content: '',
    raw: { message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } },
  });

  it('marks an unresolved tool_use as denied on a non-streaming/error turn (skip mode)', () => {
    // Reproduces "API request failed but the last tool just spins": the turn
    // never streamed (isStreaming=false, turnId=-1 → skip mode), an assistant
    // emitted a tool_use, and the error arrives before any tool_result. The
    // tool must be marked denied so it stops spinning.
    const { getMessages } = createHarness(
      [{ type: 'user', content: 'run ls' }, assistantWithToolUse('tool-1')],
      0,
    );

    // No onStreamStart happened; streaming refs are at their idle defaults.
    window.onStreamEnd!();

    expect(window.__deniedToolIds).toBeDefined();
    expect(window.__deniedToolIds!.has('tool-1')).toBe(true);
    // The list gets a new reference so the denied tool card re-renders.
    expect(getMessages()).toHaveLength(2);
  });

  it('is a no-op when the tool_use already has a matching tool_result', () => {
    const { getMessages } = createHarness(
      [
        { type: 'user', content: 'run ls' },
        assistantWithToolUse('tool-2'),
        {
          type: 'user',
          content: '[tool_result]',
          raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' }] } },
        },
      ],
      0,
    );
    const before = getMessages();

    window.onStreamEnd!();

    // Nothing dangling → no id denied, and the list reference is unchanged.
    expect(window.__deniedToolIds?.has('tool-2') ?? false).toBe(false);
    expect(getMessages()).toBe(before);
  });
});

/**
 * Transient streaming status hint lifecycle: onToolPreparing / onCompactStatus
 * set the hint; deltas, block reset, and stream end clear it.
 */
describe('streaming status hint (tool_preparing / compacting)', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    window.__deniedToolIds = undefined;
  });

  afterEach(() => {
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
    window.__deniedToolIds = undefined;
  });

  /** Start a stream so isStreamingRef is true, then return the harness handles. */
  const startStreaming = () => {
    const harness = createHarness([{ type: 'user', content: 'q' }], 0);
    window.onStreamStart!();
    return harness;
  };

  it('onToolPreparing sets a tool_preparing hint while streaming', () => {
    const { getStreamingHint } = startStreaming();

    window.onToolPreparing!('Write');

    expect(getStreamingHint()).toEqual({ kind: 'tool_preparing', toolName: 'Write' });
  });

  it('onToolPreparing is ignored when the stream is not active', () => {
    const { getStreamingHint } = createHarness([], 0);

    window.onToolPreparing!('Write');

    expect(getStreamingHint()).toBeNull();
  });

  it('onToolPreparing is ignored during session transitions', () => {
    const { getStreamingHint } = startStreaming();
    window.__sessionTransitioning = true;

    window.onToolPreparing!('Write');

    expect(getStreamingHint()).toBeNull();
  });

  it('onCompactStatus(true) sets a compacting hint; onCompactStatus(false) clears it', () => {
    const { getStreamingHint } = startStreaming();

    window.onCompactStatus!('true');
    expect(getStreamingHint()).toEqual({ kind: 'compacting' });

    window.onCompactStatus!('false');
    expect(getStreamingHint()).toBeNull();
  });

  it('onCompactStatus(false) does NOT clear a tool_preparing hint', () => {
    const { getStreamingHint } = startStreaming();
    window.onToolPreparing!('Edit');

    window.onCompactStatus!('false');

    expect(getStreamingHint()).toEqual({ kind: 'tool_preparing', toolName: 'Edit' });
  });

  it('onContentDelta clears the hint once visible text resumes', () => {
    const { getStreamingHint } = startStreaming();
    window.onToolPreparing!('Write');
    expect(getStreamingHint()).not.toBeNull();

    window.onContentDelta!('Here is the file:');

    expect(getStreamingHint()).toBeNull();
  });

  it('onThinkingDelta clears the hint', () => {
    const { getStreamingHint } = startStreaming();
    window.onCompactStatus!('true');

    window.onThinkingDelta!('thinking again');

    expect(getStreamingHint()).toBeNull();
  });

  it('onBlockReset clears the hint (new message_start within the stream)', () => {
    const { getStreamingHint } = startStreaming();
    window.onToolPreparing!('Bash');

    window.onBlockReset!();

    expect(getStreamingHint()).toBeNull();
  });

  it('onStreamEnd clears the hint (covers normal end, error finalize and stall recovery)', () => {
    const { getStreamingHint } = startStreaming();
    window.onToolPreparing!('Write');

    window.onStreamEnd!();

    expect(getStreamingHint()).toBeNull();
  });

  it('onStreamEnd in skip mode (turn never streamed) also clears a leftover hint', () => {
    const { getStreamingHint, setStreamingHintState } = createHarness([], 0);
    // Simulate a hint that leaked past a lost cleanup path.
    setStreamingHintState({ kind: 'compacting' });

    window.onStreamEnd!();

    expect(getStreamingHint()).toBeNull();
  });

  it('onStreamStart clears a hint leaked from the previous turn', () => {
    const { getStreamingHint, setStreamingHintState } = createHarness([{ type: 'user', content: 'q' }], 0);
    setStreamingHintState({ kind: 'tool_preparing', toolName: 'Write' });

    window.onStreamStart!();

    expect(getStreamingHint()).toBeNull();
  });
});
