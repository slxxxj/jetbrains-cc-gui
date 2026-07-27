import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

export interface RecallRequest {
  sessionId: string;
  userMessageId: string;
  messageContent: string;
  messageTimestamp?: string;
  /** Messages that will be discarded, including the recalled one. */
  discardCount: number;
  /** Estimated number of modified files the SDK will restore. */
  filesToRestore: number;
  /** True when recalling the very first user message (deletes the session). */
  isFirstMessage: boolean;
}

interface RecallDialogProps {
  isOpen: boolean;
  request: RecallRequest | null;
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm dialog for the message-level recall (撤回) feature.
 * Shows a preview of the recalled message, how many messages will be
 * discarded, and how many files will be restored.
 */
const RecallDialog = ({
  isOpen,
  request,
  isLoading = false,
  onConfirm,
  onCancel,
}: RecallDialogProps) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        // While a recall is in flight the backend is already truncating the
        // session; cancelling now would leave the UI out of sync with disk.
        if (e.key === 'Escape' && !isLoading) {
          onCancel();
        }
      };
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, isLoading, onCancel]);

  if (!isOpen || !request) {
    return null;
  }

  const displayContent = request.messageContent.length > 50
    ? `${request.messageContent.substring(0, 50)}...`
    : request.messageContent;

  return (
    <div className="confirm-dialog-overlay" onClick={isLoading ? undefined : onCancel}>
      <div className="confirm-dialog rewind-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-header">
          <h3 className="confirm-dialog-title">
            <span className="rewind-icon">&#x21A9;</span> {t('recall.title', 'Recall Message')}
          </h3>
        </div>
        <div className="confirm-dialog-body">
          {isLoading ? (
            <div className="rewind-loading">
              <span className="codicon codicon-loading codicon-modifier-spin rewind-loading-icon" />
              <span className="rewind-loading-text">{t('recall.recalling', 'Recalling...')}</span>
            </div>
          ) : (
            <>
              <div className="rewind-target">
                <div className="rewind-target-label">{t('recall.recallTo', 'Recall to')}:</div>
                <div className="rewind-target-message">
                  {request.messageTimestamp && (
                    <span className="rewind-timestamp">[{request.messageTimestamp}]</span>
                  )}
                  <span className="rewind-content">"{displayContent}"</span>
                </div>
              </div>

              <div className="rewind-warning">
                <div className="rewind-warning-icon">&#x26A0;</div>
                <div className="rewind-warning-content">
                  <div className="rewind-warning-title">{t('recall.impact', 'Impact')}:</div>
                  <ul className="rewind-warning-list">
                    <li>
                      {t('recall.discardCount', {
                        count: request.discardCount,
                        defaultValue: 'Will discard {{count}} message(s) including this one',
                      })}
                    </li>
                    <li>
                      {request.filesToRestore > 0
                        ? t('recall.filesRestore', {
                            count: request.filesToRestore,
                            defaultValue: 'Will restore about {{count}} modified file(s)',
                          })
                        : t('recall.noFilesRestore', 'No file changes to restore')}
                    </li>
                    <li>{t('recall.textRestored', 'The message text will be restored to the input box')}</li>
                    {request.isFirstMessage && (
                      <li>{t('recall.firstMessageNote', 'First message: the session will be deleted and a fresh one starts on next send')}</li>
                    )}
                  </ul>
                </div>
              </div>

              <p className="rewind-note">
                {t('recall.cannotUndo', 'This action cannot be undone.')}
              </p>
            </>
          )}
        </div>
        <div className="confirm-dialog-footer">
          {isLoading ? (
            <button className="confirm-dialog-button cancel-button" disabled>
              {t('recall.recalling', 'Recalling...')}
            </button>
          ) : (
            <>
              <button className="confirm-dialog-button cancel-button" onClick={onCancel}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                className="confirm-dialog-button confirm-button rewind-confirm-button"
                onClick={onConfirm}
                autoFocus
              >
                {t('recall.confirm', 'Recall')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default RecallDialog;
