import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sendBridgeEvent } from '../../../utils/bridge';

/**
 * Per-SDK entry as reported by the backend `check_dependency_updates` message.
 */
interface SdkUpdateEntry {
  sdkName: string;
  installed: boolean;
  currentVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
  error?: string;
}

interface CheckResultPayload {
  success: boolean;
  error?: string;
  sdks?: Record<string, SdkUpdateEntry>;
}

interface UpdateResultPayload {
  success: boolean;
  sdkId?: string;
  version?: string;
  error?: string;
}

const UP_TO_DATE_RESET_MS = 3000;
const DONE_RESET_MS = 8000;

/**
 * Manual SDK update actions rendered at the bottom of the model selector
 * dropdown. Mirrors the cc-switch flow: the user clicks "check for updates",
 * sees which SDKs have a newer registry version, and clicks to update them
 * one by one. Results arrive via the window callbacks
 * `dependencyUpdateCheckResult` / `dependencyUpdateResult` served by
 * `DependencyHandler` on the Java side.
 */
export const SdkUpdateOptions = () => {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [upToDate, setUpToDate] = useState(false);
  /** Updates found by the last check, keyed by SDK id; entries are removed as they get updated. */
  const [pendingUpdates, setPendingUpdates] = useState<Record<string, SdkUpdateEntry> | null>(null);
  const [updatingSdk, setUpdatingSdk] = useState<{ id: string; name: string } | null>(null);
  const [updateError, setUpdateError] = useState<{ id: string; name: string; error?: string } | null>(null);
  const [doneInfo, setDoneInfo] = useState<{ name: string; version?: string } | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleReset = useCallback((action: () => void, delay: number) => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = setTimeout(action, delay);
  }, []);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  // Register window callbacks (chained with any pre-registered handlers) — mount once.
  useEffect(() => {
    const savedCheckResult = window.dependencyUpdateCheckResult;
    const savedUpdateResult = window.dependencyUpdateResult;

    window.dependencyUpdateCheckResult = (jsonStr: string) => {
      try {
        const payload = JSON.parse(jsonStr) as CheckResultPayload;
        setChecking(false);
        if (!payload.success) {
          setCheckError(payload.error ?? null);
          return;
        }
        const found: Record<string, SdkUpdateEntry> = {};
        for (const [sdkId, entry] of Object.entries(payload.sdks ?? {})) {
          if (entry.installed && entry.hasUpdate && entry.latestVersion) {
            found[sdkId] = entry;
          }
        }
        setCheckError(null);
        if (Object.keys(found).length > 0) {
          setPendingUpdates(found);
          setUpToDate(false);
        } else {
          setPendingUpdates(null);
          setUpToDate(true);
          scheduleReset(() => setUpToDate(false), UP_TO_DATE_RESET_MS);
        }
      } catch (error) {
        console.error('[SdkUpdateOptions] Failed to parse update check result:', error);
        setChecking(false);
      }
      if (typeof savedCheckResult === 'function') {
        try { savedCheckResult(jsonStr); } catch (e) {
          console.error('[SdkUpdateOptions] Error in chained dependencyUpdateCheckResult:', e);
        }
      }
    };

    window.dependencyUpdateResult = (jsonStr: string) => {
      try {
        const payload = JSON.parse(jsonStr) as UpdateResultPayload;
        const sdkId = payload.sdkId ?? '';
        setUpdatingSdk((current) => {
          if (payload.success) {
            setPendingUpdates((prev) => {
              if (!prev) {
                return prev;
              }
              const next = { ...prev };
              delete next[sdkId];
              return Object.keys(next).length > 0 ? next : null;
            });
            setUpdateError(null);
            setDoneInfo({ name: current?.name ?? sdkId, version: payload.version });
            scheduleReset(() => setDoneInfo(null), DONE_RESET_MS);
            // Refresh the read-only status so the settings panel shows the new version.
            sendBridgeEvent('get_dependency_status');
          } else {
            setUpdateError({ id: sdkId, name: current?.name ?? sdkId, error: payload.error });
          }
          return null;
        });
      } catch (error) {
        console.error('[SdkUpdateOptions] Failed to parse update result:', error);
        setUpdatingSdk(null);
      }
      if (typeof savedUpdateResult === 'function') {
        try { savedUpdateResult(jsonStr); } catch (e) {
          console.error('[SdkUpdateOptions] Error in chained dependencyUpdateResult:', e);
        }
      }
    };

    return () => {
      window.dependencyUpdateCheckResult = savedCheckResult;
      window.dependencyUpdateResult = savedUpdateResult;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCheck = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setChecking(true);
    setCheckError(null);
    setUpToDate(false);
    setDoneInfo(null);
    setUpdateError(null);
    sendBridgeEvent('check_dependency_updates');
  }, []);

  const handleUpdate = useCallback((sdkId: string, name: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setUpdateError(null);
    setDoneInfo(null);
    setUpdatingSdk({ id: sdkId, name });
    sendBridgeEvent('update_dependency', { sdkId });
  }, []);

  const pendingEntries = Object.entries(pendingUpdates ?? {});

  return (
    <>
      <div className="selector-divider" />

      {/* Checking spinner */}
      {checking && (
        <div className="selector-option selector-option-status" data-testid="sdk-update-checking">
          <span className="codicon codicon-loading codicon-modifier-spin selector-add-icon" />
          <span>{t('models.sdkUpdate.checking')}</span>
        </div>
      )}

      {/* Check failed — click to retry */}
      {!checking && checkError !== null && (
        <div
          className="selector-option selector-option-refresh"
          data-testid="sdk-update-check-failed"
          title={checkError}
          onClick={handleCheck}
        >
          <span className="codicon codicon-warning selector-add-icon" />
          <span>{t('models.sdkUpdate.checkFailed')}</span>
        </div>
      )}

      {/* Up to date confirmation (auto-hides) */}
      {!checking && upToDate && (
        <div className="selector-option selector-option-status" data-testid="sdk-update-up-to-date">
          <span className="codicon codicon-check selector-add-icon" />
          <span>{t('models.sdkUpdate.upToDate')}</span>
        </div>
      )}

      {/* Pending updates — one row per SDK */}
      {!checking && !updatingSdk && pendingEntries.map(([sdkId, entry]) => (
        <div
          key={sdkId}
          className="selector-option selector-option-refresh"
          data-testid={`sdk-update-action-${sdkId}`}
          onClick={handleUpdate(sdkId, entry.sdkName)}
        >
          <span className="codicon codicon-cloud-download selector-add-icon" />
          <span>
            {t('models.sdkUpdate.action', {
              name: entry.sdkName,
              current: entry.currentVersion ?? '?',
              latest: entry.latestVersion ?? '?',
            })}
          </span>
        </div>
      ))}

      {/* Update in flight */}
      {updatingSdk && (
        <div className="selector-option selector-option-status" data-testid="sdk-update-updating">
          <span className="codicon codicon-loading codicon-modifier-spin selector-add-icon" />
          <span>{t('models.sdkUpdate.updating', { name: updatingSdk.name })}</span>
        </div>
      )}

      {/* Update failed — click to retry */}
      {!updatingSdk && updateError && (
        <div
          className="selector-option selector-option-refresh"
          data-testid="sdk-update-failed"
          title={updateError.error}
          onClick={handleUpdate(updateError.id, updateError.name)}
        >
          <span className="codicon codicon-warning selector-add-icon" />
          <span>{t('models.sdkUpdate.updateFailed', { name: updateError.name })}</span>
        </div>
      )}

      {/* Update completed (auto-hides) */}
      {doneInfo && (
        <div className="selector-option selector-option-status" data-testid="sdk-update-done">
          <span className="codicon codicon-check selector-add-icon" />
          <span>{t('models.sdkUpdate.done', { name: doneInfo.name, version: doneInfo.version ?? '' })}</span>
        </div>
      )}

      {/* Default entry point */}
      {!checking && !updatingSdk && pendingEntries.length === 0 && !upToDate && !doneInfo && (
        <div
          className="selector-option selector-option-refresh"
          data-testid="sdk-update-check"
          title={t('models.sdkUpdate.checkHint')}
          onClick={handleCheck}
        >
          <span className="codicon codicon-cloud-download selector-add-icon" />
          <span>{t('models.sdkUpdate.check')}</span>
        </div>
      )}
    </>
  );
};

export default SdkUpdateOptions;
