import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { useRecallHandlers } from './useRecallHandlers';
import type { RecallRequest } from '../components/RecallDialog';
import type { ClaudeMessage } from '../types';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

const t = ((key: string) => key) as any;

const userMessage = (uuid: string, content: string): ClaudeMessage => ({
  type: 'user',
  content,
  raw: { uuid },
});

const assistantMessage = (): ClaudeMessage => ({ type: 'assistant', content: 'reply' });

const assistantEditMessage = (): ClaudeMessage => ({
  type: 'assistant',
  raw: {
    message: {
      content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } },
      ],
    },
  },
});

const defaultMessages = (): ClaudeMessage[] => [
  userMessage('u1', 'first'), // index 0
  assistantMessage(), // index 1
  userMessage('u2', 'second'), // index 2
  assistantEditMessage(), // index 3
];

const setup = (opts: { sessionId?: string | null; messages?: ClaudeMessage[] } = {}) => {
  const addToast = vi.fn();
  const setDraftInput = vi.fn();
  const initialMessages = opts.messages ?? defaultMessages();
  const initialSessionId = opts.sessionId === undefined ? 'session-1' : opts.sessionId;

  const view = renderHook(() => {
    const [messages, setMessages] = useState<ClaudeMessage[]>(initialMessages);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(initialSessionId);
    const [currentRecallRequest, setCurrentRecallRequest] = useState<RecallRequest | null>(null);
    const [recallDialogOpen, setRecallDialogOpen] = useState(false);
    const [isRecalling, setIsRecalling] = useState(false);
    const handlers = useRecallHandlers({
      t,
      addToast,
      messages,
      setMessages,
      currentSessionId,
      setCurrentSessionId,
      setDraftInput,
      currentRecallRequest,
      setCurrentRecallRequest,
      setRecallDialogOpen,
      setIsRecalling,
    });
    return { ...handlers, messages, currentSessionId, currentRecallRequest, recallDialogOpen, isRecalling };
  });

  return { ...view, addToast, setDraftInput };
};

/** Click the 'u2' user message (index 2) and confirm the dialog. */
const clickAndConfirm = (result: { current: ReturnType<typeof setup>['result']['current'] }) => {
  act(() => {
    result.current.handleRecallClick(result.current.messages[2]);
  });
  act(() => {
    result.current.handleRecallConfirm();
  });
};

const emitRecallResult = (payload: unknown) => {
  act(() => {
    window.onRecallResult?.(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
};

describe('useRecallHandlers', () => {
  beforeEach(() => {
    sendBridgeEventMock.mockClear();
  });

  describe('handleRecallClick guards', () => {
    it('warns and does not open the dialog without a current session', () => {
      const { result, addToast } = setup({ sessionId: null });

      act(() => {
        result.current.handleRecallClick(result.current.messages[2]);
      });

      expect(addToast).toHaveBeenCalledWith('recall.notAvailable', 'warning');
      expect(result.current.currentRecallRequest).toBeNull();
      expect(result.current.recallDialogOpen).toBe(false);
    });

    it('warns and does not open the dialog for a message without uuid', () => {
      const { result, addToast } = setup();

      act(() => {
        result.current.handleRecallClick({ type: 'user', content: 'no uuid here' });
      });

      expect(addToast).toHaveBeenCalledWith('recall.notAvailable', 'warning');
      expect(result.current.currentRecallRequest).toBeNull();
      expect(result.current.recallDialogOpen).toBe(false);
    });

    it('warns and does not open the dialog when the uuid is not in the message list', () => {
      const { result, addToast } = setup();

      act(() => {
        result.current.handleRecallClick(userMessage('ghost-uuid', 'not in list'));
      });

      expect(addToast).toHaveBeenCalledWith('recall.notAvailable', 'warning');
      expect(result.current.currentRecallRequest).toBeNull();
      expect(result.current.recallDialogOpen).toBe(false);
    });

    it('sets the recall request and opens the dialog on the happy path', () => {
      const { result } = setup();

      act(() => {
        result.current.handleRecallClick(result.current.messages[2]);
      });

      expect(result.current.currentRecallRequest).toEqual({
        sessionId: 'session-1',
        userMessageId: 'u2',
        messageContent: 'second',
        discardCount: 2, // 4 messages - rawIndex 2
        filesToRestore: 1, // Edit on /a.ts after index 2
        isFirstMessage: false,
      });
      expect(result.current.recallDialogOpen).toBe(true);
    });

    it('marks the first message and counts all later file changes', () => {
      const { result } = setup();

      act(() => {
        result.current.handleRecallClick(result.current.messages[0]);
      });

      expect(result.current.currentRecallRequest).toEqual({
        sessionId: 'session-1',
        userMessageId: 'u1',
        messageContent: 'first',
        discardCount: 4,
        filesToRestore: 1,
        isFirstMessage: true,
      });
      expect(result.current.recallDialogOpen).toBe(true);
    });
  });

  describe('handleRecallConfirm', () => {
    it('sends recall_message and sets isRecalling', () => {
      const { result } = setup();

      act(() => {
        result.current.handleRecallClick(result.current.messages[2]);
      });
      act(() => {
        result.current.handleRecallConfirm();
      });

      expect(result.current.isRecalling).toBe(true);
      expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
      expect(sendBridgeEventMock).toHaveBeenCalledWith('recall_message', {
        sessionId: 'session-1',
        userMessageId: 'u2',
        firstMessage: false,
      });
    });

    it('is a no-op without a current request', () => {
      const { result } = setup();

      act(() => {
        result.current.handleRecallConfirm();
      });

      expect(sendBridgeEventMock).not.toHaveBeenCalled();
      expect(result.current.isRecalling).toBe(false);
    });
  });

  describe('handleRecallCancel', () => {
    it('resets isRecalling, closes the dialog and clears the request', () => {
      const { result } = setup();
      clickAndConfirm(result);
      expect(result.current.isRecalling).toBe(true);

      act(() => {
        result.current.handleRecallCancel();
      });

      expect(result.current.isRecalling).toBe(false);
      expect(result.current.recallDialogOpen).toBe(false);
      expect(result.current.currentRecallRequest).toBeNull();
    });
  });

  describe('onRecallResult', () => {
    it('shows an error toast and keeps messages on invalid JSON', () => {
      const { result, addToast } = setup();
      clickAndConfirm(result);

      emitRecallResult('not-json{');

      expect(result.current.isRecalling).toBe(false);
      expect(addToast).toHaveBeenCalledWith('recall.failed', 'error');
      expect(result.current.messages).toHaveLength(4);
      expect(sendBridgeEventMock).toHaveBeenCalledTimes(1); // only recall_message
    });

    it('shows the backend error message and keeps messages on success:false', () => {
      const { result, addToast } = setup();
      clickAndConfirm(result);

      emitRecallResult({ success: false, message: 'boom' });

      expect(result.current.isRecalling).toBe(false);
      expect(addToast).toHaveBeenCalledWith('boom', 'error');
      expect(result.current.messages).toHaveLength(4);
      expect(sendBridgeEventMock).toHaveBeenCalledTimes(1); // no further bridge events
    });

    it('truncates at the uuid, restores the draft and reloads the session on success', () => {
      const { result, addToast, setDraftInput } = setup();
      clickAndConfirm(result);
      sendBridgeEventMock.mockClear();

      emitRecallResult({ success: true });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0]).toMatchObject({ content: 'first' });
      expect(result.current.messages[1]).toMatchObject({ content: 'reply' });
      expect(setDraftInput).toHaveBeenCalledWith('second');
      expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
      expect(sendBridgeEventMock).toHaveBeenCalledWith(
        'load_session',
        JSON.stringify({ sessionId: 'session-1', provider: 'claude' }),
      );
      expect(result.current.recallDialogOpen).toBe(false);
      expect(result.current.currentRecallRequest).toBeNull();
      expect(result.current.isRecalling).toBe(false);
      expect(addToast).toHaveBeenCalledWith('recall.success', 'success');
    });

    it('resets the session and sends create_new_session on deletedSession', () => {
      const { result, addToast } = setup();
      clickAndConfirm(result);
      sendBridgeEventMock.mockClear();

      emitRecallResult({ success: true, deletedSession: true });

      expect(result.current.messages).toEqual([]);
      expect(result.current.currentSessionId).toBeNull();
      expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
      expect(sendBridgeEventMock).toHaveBeenCalledWith('create_new_session');
      expect(addToast).toHaveBeenCalledWith('recall.success', 'success');
    });

    it('resets the session when recalling the first message even without deletedSession', () => {
      const { result } = setup();

      act(() => {
        result.current.handleRecallClick(result.current.messages[0]);
      });
      act(() => {
        result.current.handleRecallConfirm();
      });
      expect(sendBridgeEventMock).toHaveBeenCalledWith('recall_message', {
        sessionId: 'session-1',
        userMessageId: 'u1',
        firstMessage: true,
      });
      sendBridgeEventMock.mockClear();

      emitRecallResult({ success: true });

      expect(result.current.messages).toEqual([]);
      expect(result.current.currentSessionId).toBeNull();
      expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
      expect(sendBridgeEventMock).toHaveBeenCalledWith('create_new_session');
    });

    it('shows a warning toast when the result carries a warning', () => {
      const { result, addToast } = setup();
      clickAndConfirm(result);

      emitRecallResult({ success: true, warning: 'partial restore' });

      expect(addToast).toHaveBeenCalledWith('recall.successWithWarning', 'warning');
      expect(addToast).not.toHaveBeenCalledWith('recall.success', 'success');
      // Truncation still happened.
      expect(result.current.messages).toHaveLength(2);
    });

    it('ignores a late success after cancel: no truncation, draft restore or resync events', () => {
      const { result, addToast, setDraftInput } = setup();
      clickAndConfirm(result);

      act(() => {
        result.current.handleRecallCancel();
      });
      expect(result.current.currentRecallRequest).toBeNull();

      emitRecallResult({ success: true });

      // requestRef is null, so the success path must not touch messages/draft/bridge.
      expect(result.current.messages).toHaveLength(4);
      expect(setDraftInput).not.toHaveBeenCalled();
      expect(sendBridgeEventMock).toHaveBeenCalledTimes(1); // still only recall_message
      // Pinned behavior: the success toast lives outside the request guard,
      // so it is still shown even though the recall was cancelled.
      expect(addToast).toHaveBeenCalledWith('recall.success', 'success');
    });
  });
});
