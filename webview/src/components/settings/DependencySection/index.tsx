import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SdkId,
  SdkStatus,
  SdkInstallStatus,
} from '../../../types/dependency';
import { sendBridgeEvent } from '../../../utils/bridge';
import styles from './style.module.less';

interface DependencySectionProps {
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  isActive: boolean;
}

const SDK_DEFINITIONS = [
  {
    id: 'claude-sdk' as SdkId,
    nameKey: 'settings.dependency.claudeSdkName',
    description: 'settings.dependency.claudeSdkDescription',
    relatedProviders: ['anthropic', 'bedrock'],
  },
  {
    id: 'codex-sdk' as SdkId,
    nameKey: 'settings.dependency.codexSdkName',
    description: 'settings.dependency.codexSdkDescription',
    relatedProviders: ['openai'],
  },
];

const STATUS_PRESENTATION: Record<SdkInstallStatus, { styleKey: string; labelKey: string }> = {
  installed: {
    styleKey: 'statusInstalled',
    labelKey: 'settings.dependency.statusInstalled',
  },
  not_installed: {
    styleKey: 'statusNotInstalled',
    labelKey: 'settings.dependency.statusNotInstalled',
  },
  installing: {
    styleKey: 'statusInstalling',
    labelKey: 'settings.dependency.statusInstalling',
  },
  error: {
    styleKey: 'statusError',
    labelKey: 'settings.dependency.statusError',
  },
};

/**
 * Read-only SDK dependency status panel.
 *
 * SDK installation is automatic on the backend (silent install on first
 * launch); updates are checked automatically in the background and applied
 * only after the user confirms via the update notification. This section only
 * renders the status reported by `get_dependency_status`; all interactive
 * install/uninstall/update/version-selection controls were removed.
 */
const DependencySection = ({ isActive }: DependencySectionProps) => {
  const { t } = useTranslation();
  const [sdkStatus, setSdkStatus] = useState<Record<SdkId, SdkStatus>>({} as Record<SdkId, SdkStatus>);
  const [loading, setLoading] = useState(true);

  // Setup window callback - run once on mount only
  useEffect(() => {
    // Capture current callback reference (may have been set by App.tsx)
    const savedUpdateDependencyStatus = window.updateDependencyStatus;

    window.updateDependencyStatus = (jsonStr: string) => {
      try {
        const status = JSON.parse(jsonStr);
        setSdkStatus(status);
      } catch (error) {
        console.error('[DependencySection] Failed to parse dependency status:', error);
      }
      setLoading(false);
      if (typeof savedUpdateDependencyStatus === 'function') {
        try { savedUpdateDependencyStatus(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained updateDependencyStatus:', e);
        }
      }
    };

    return () => {
      window.updateDependencyStatus = savedUpdateDependencyStatus;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh status when tab becomes active
  useEffect(() => {
    if (!isActive) {
      return;
    }
    sendBridgeEvent('get_dependency_status');
  }, [isActive]);

  return (
    <div className={styles.dependencySection}>
      <h3 className={styles.sectionTitle}>{t('settings.dependency.title')}</h3>
      <p className={styles.sectionDesc}>{t('settings.dependency.description')}</p>

      {/* Auto-install policy tip */}
      <div className={styles.sdkWarningBar}>
        <span className="codicon codicon-info" />
        <span className={styles.warningText}>{t('settings.dependency.installPolicyTip')}</span>
      </div>

      {/* SDK List (read-only) */}
      <div className={styles.sdkList}>
        {loading ? (
          <div className={styles.loadingState}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>{t('settings.dependency.loading')}</span>
          </div>
        ) : (
          SDK_DEFINITIONS.map((sdk) => {
            const info = sdkStatus[sdk.id];
            const status: SdkInstallStatus = info?.status ?? 'not_installed';
            const presentation = STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.not_installed;

            return (
              <div key={sdk.id} className={styles.sdkCard}>
                <div className={styles.sdkHeader}>
                  <div className={styles.sdkInfo}>
                    <div className={styles.sdkName}>
                      <span className={`codicon ${status === 'installed' ? 'codicon-check' : 'codicon-package'}`} />
                      <span>{t(sdk.nameKey)}</span>
                      {info?.installedVersion && (
                        <span className={styles.versionBadge}>v{info.installedVersion}</span>
                      )}
                      <span className={`${styles.statusBadge} ${styles[presentation.styleKey]}`}>
                        {status === 'installing' && (
                          <span className="codicon codicon-loading codicon-modifier-spin" />
                        )}
                        <span>{t(presentation.labelKey)}</span>
                      </span>
                    </div>
                    <div className={styles.sdkDescription}>{t(sdk.description)}</div>
                    {status === 'error' && info?.errorMessage && (
                      <div className={styles.errorText}>{info.errorMessage}</div>
                    )}
                  </div>
                </div>

                {/* Install path info */}
                {info?.installPath && (
                  <div className={styles.installPath}>
                    <span className="codicon codicon-folder" />
                    <span>{info.installPath}</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default DependencySection;
