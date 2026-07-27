import { useCallback, useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage } from '../types';
import type { RecallRequest } from '../components/RecallDialog';
import { sendBridgeEvent } from '../utils/bridge';
import { formatTime } from '../utils/helpers';
import {
  countFileChangesAfter,
  extractUserMessageText,
  findRecallIndex,
  getMessageUuid,
} from '../utils/recallUtils';

export interface UseRecallHandlersOptions {
  t: TFunction;
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  /** Raw messages from MessagesContext (NOT the merged render list). */
  messages: ClaudeMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  currentSessionId: string | null;
  setCurrentSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftInput: (value: string) => void;
  currentRecallRequest: RecallRequest | null;
  setCurrentRecallRequest: (request: RecallRequest | null) => void;
  setRecallDialogOpen: (open: boolean) => void;
  setIsRecalling: (loading: boolean) => void;
}

export interface UseRecallHandlersReturn {
  /** Open the recall confirm dialog for a user message. */
  handleRecallClick: (message: ClaudeMessage) => void;
  handleRecallConfirm: () => void;
  handleRecallCancel: () => void;
}

interface RecallResultPayload {
  success?: boolean;
  message?: string;
  warning?: string;
  deletedSession?: boolean;
  removedMessages?: number;
  filesRestored?: number;
}

/**
 * Handlers for the message-level recall (撤回) feature.
 *
 * Unlike file rewind (files only, history kept), recall is a combination of:
 *  1. frontend truncation of the message list,
 *  2. backend file restore via the SDK checkpoint rewind,
 *  3. backend JSONL truncation (or full session deletion for the 1st message),
 * and the recalled text is restored into the input box.
 */
export function useRecallHandlers(options: UseRecallHandlersOptions): UseRecallHandlersReturn {
  const {
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
  } = options;

  // Refs so the window callback always sees the latest values.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const requestRef = useRef(currentRecallRequest);
  requestRef.current = currentRecallRequest;

  const handleRecallClick = useCallback((message: ClaudeMessage) => {
    if (!currentSessionId) {
      addToast(t('recall.notAvailable', 'Recall is not available for this message'), 'warning');
      return;
    }
    const uuid = getMessageUuid(message);
    if (!uuid) {
      addToast(t('recall.notAvailable', 'Recall is not available for this message'), 'warning');
      return;
    }
    const rawIndex = findRecallIndex(messagesRef.current, uuid);
    if (rawIndex < 0) {
      addToast(t('recall.notAvailable', 'Recall is not available for this message'), 'warning');
      return;
    }

    const content = extractUserMessageText(message);
    setCurrentRecallRequest({
      sessionId: currentSessionId,
      userMessageId: uuid,
      messageContent: content,
      messageTimestamp: message.timestamp ? formatTime(message.timestamp) : undefined,
      // Including the recalled message itself.
      discardCount: messagesRef.current.length - rawIndex,
      filesToRestore: countFileChangesAfter(messagesRef.current, rawIndex),
      isFirstMessage: rawIndex === 0,
    });
    setRecallDialogOpen(true);
  }, [currentSessionId, addToast, t, setCurrentRecallRequest, setRecallDialogOpen]);

  const handleRecallConfirm = useCallback(() => {
    const request = requestRef.current;
    if (!request) return;
    setIsRecalling(true);
    sendBridgeEvent('recall_message', {
      sessionId: request.sessionId,
      userMessageId: request.userMessageId,
      firstMessage: request.isFirstMessage,
    });
  }, [setIsRecalling]);

  const handleRecallCancel = useCallback(() => {
    setIsRecalling(false);
    setRecallDialogOpen(false);
    setCurrentRecallRequest(null);
  }, [setIsRecalling, setRecallDialogOpen, setCurrentRecallRequest]);

  // Backend result: truncate the UI, restore the draft, resync the session.
  useEffect(() => {
    window.onRecallResult = (json: string) => {
      const request = requestRef.current;
      let result: RecallResultPayload;
      try {
        result = JSON.parse(json) as RecallResultPayload;
      } catch {
        setIsRecalling(false);
        addToast(t('recall.failed', 'Recall failed'), 'error');
        return;
      }
      setIsRecalling(false);

      if (!result.success) {
        addToast(result.message || t('recall.failed', 'Recall failed'), 'error');
        return;
      }

      setRecallDialogOpen(false);
      setCurrentRecallRequest(null);

      if (request) {
        // Restore the recalled text into the input box.
        if (request.messageContent) {
          setDraftInput(request.messageContent);
        }

        if (result.deletedSession || request.isFirstMessage) {
          // First-message recall: the session file is gone — reset everything
          // so the next send starts a brand-new SDK session.
          setMessages([]);
          setCurrentSessionId(null);
          sendBridgeEvent('create_new_session');
        } else {
          // Truncate the visible conversation (defensive: recompute the index
          // in the latest list) and reload the session from the truncated
          // JSONL so the backend runtime drops the discarded turns as well.
          setMessages(prev => {
            const idx = findRecallIndex(prev, request.userMessageId);
            return idx >= 0 ? prev.slice(0, idx) : prev;
          });
          sendBridgeEvent('load_session', JSON.stringify({
            sessionId: request.sessionId,
            provider: 'claude',
          }));
        }
      }

      if (result.warning) {
        addToast(t('recall.successWithWarning', 'Recalled, but file restore had issues'), 'warning');
      } else {
        addToast(t('recall.success', 'Message recalled'), 'success');
      }
    };

    return () => {
      delete window.onRecallResult;
    };
  }, [t, addToast, setMessages, setCurrentSessionId, setDraftInput, setIsRecalling, setRecallDialogOpen, setCurrentRecallRequest]);

  return {
    handleRecallClick,
    handleRecallConfirm,
    handleRecallCancel,
  };
}
