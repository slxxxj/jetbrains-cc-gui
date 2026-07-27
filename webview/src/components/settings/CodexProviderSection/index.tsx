import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../../types/provider';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';
import { sendToJava } from '../../../utils/bridge';
import { useDragSort } from '../hooks/useDragSort';
import ImportConfirmDialog from '../ProviderList/ImportConfirmDialog';
import sharedStyles from '../ProviderList/style.module.less';
import styles from './style.module.less';

const ICON_MR_8_STYLE: React.CSSProperties = { marginRight: '8px' };
const CLI_LOGIN_NOTE_STYLE: React.CSSProperties = { marginTop: '4px', opacity: 0.8 };

interface CodexProviderSectionProps {
  codexProviders: CodexProviderConfig[];
  codexLoading: boolean;
  onAddCodexProvider: () => void;
  onEditCodexProvider: (provider: CodexProviderConfig) => void;
  onDeleteCodexProvider: (provider: CodexProviderConfig) => void;
  onSwitchCodexProvider: (id: string) => void;
  onRevokeCodexLocalConfigAuthorization: (fallbackProviderId?: string) => void;
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  showHeader?: boolean;
}

const CodexProviderSection = ({
  codexProviders,
  codexLoading,
  onAddCodexProvider,
  onEditCodexProvider,
  onDeleteCodexProvider,
  onSwitchCodexProvider,
  onRevokeCodexLocalConfigAuthorization,
  addToast,
  showHeader = true,
}: CodexProviderSectionProps) => {
  const { t } = useTranslation();

  const [showCliLoginConfirm, setShowCliLoginConfirm] = useState(false);
  const [showCliLoginDisableConfirm, setShowCliLoginDisableConfirm] = useState(false);

  // cc-switch import state (mirrors the Claude ProviderList import flow)
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importPreviewData, setImportPreviewData] = useState<any[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [editingCcSwitchProvider, setEditingCcSwitchProvider] = useState<CodexProviderConfig | null>(null);
  const [convertingProvider, setConvertingProvider] = useState<CodexProviderConfig | null>(null);
  const importMenuRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(event.target as Node)) {
        setImportMenuOpen(false);
      }
    };

    // Register the global callback for Java to push Codex import preview results.
    // Distinct from ProviderList's import_preview_result: both sections stay mounted
    // (tab display toggling), so each side needs its own callback name.
    window.codex_import_preview_result = (dataOrStr) => {
      let data: unknown = dataOrStr;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
          console.error('Failed to parse codex_import_preview_result data:', e);
        }
      }
      const event = new CustomEvent('codex_import_preview_result', { detail: data });
      window.dispatchEvent(event);
    };

    const handleImportPreview = (event: CustomEvent) => {
      setIsImporting(false); // Received result, hide loading
      const data = event.detail;
      if (data && data.providers) {
        setImportPreviewData(data.providers);
        setShowImportDialog(true);
      }
    };

    // Errors/notifications are toasted by ProviderList's backend_notification listener;
    // here we only need to stop the loading spinner.
    const handleBackendNotification = () => {
      setIsImporting(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('codex_import_preview_result', handleImportPreview as EventListener);
    window.addEventListener('backend_notification', handleBackendNotification as EventListener);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('codex_import_preview_result', handleImportPreview as EventListener);
      window.removeEventListener('backend_notification', handleBackendNotification as EventListener);

      delete window.codex_import_preview_result;
    };
  }, []);

  const handleEditClick = (provider: CodexProviderConfig) => {
    if (provider.source === 'cc-switch') {
      setEditingCcSwitchProvider(provider);
    } else {
      onEditCodexProvider(provider);
    }
  };

  const handleConvert = () => {
    if (convertingProvider) {
      // Disconnect the cc-switch ID link by importing under a new ID without the
      // source marker; the imported provider becomes a standalone plugin config.
      const oldId = convertingProvider.id;
      const newId = `${oldId}_local`;

      const newProvider: CodexProviderConfig = {
        ...convertingProvider,
        id: newId,
        name: convertingProvider.name + ' (Local)',
      };
      delete newProvider.source;

      sendToJava('add_codex_provider', newProvider);
      sendToJava('delete_codex_provider', { id: oldId });

      setConvertingProvider(null);
      addToast?.(t('settings.provider.convertSuccess'), 'success');

      if (editingCcSwitchProvider && editingCcSwitchProvider.id === convertingProvider.id) {
        setEditingCcSwitchProvider(null);
        // Continue editing the new provider
        onEditCodexProvider(newProvider);
      }
    }
  };

  const handleSelectFileClick = () => {
    setImportMenuOpen(false);
    setIsImporting(true);
    // Let the backend open the system file chooser to get the correct absolute path
    sendToJava('open_file_chooser_for_codex_cc_switch');
  };

  const onSort = useCallback((orderedIds: string[]) => {
    sendToJava('sort_codex_providers', { orderedIds });
  }, []);

  // Filter out CLI Login provider from drag-sort list
  const regularProviders = useMemo(
    () => codexProviders.filter((p) => p.id !== SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN),
    [codexProviders]
  );

  const {
    localItems: localProviders,
    draggedId: draggedProviderId,
    dragOverId: dragOverProviderId,
    handlePointerDown,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
  } = useDragSort({
    items: regularProviders,
    onSort,
  });

  const cliLoginProvider = useMemo(
    () => codexProviders.find((p) => p.id === SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN),
    [codexProviders]
  );
  const isCliLoginActive = cliLoginProvider?.isActive === true;

  return (
    <div className={styles.configSection}>
      {showHeader && (
        <>
          <h3 className={styles.sectionTitle}>{t('settings.codexProvider.title')}</h3>
          <p className={styles.sectionDesc}>{t('settings.codexProvider.description')}</p>
        </>
      )}

      {/* CLI Login authorize confirm dialog */}
      {showCliLoginConfirm && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-key" />
              {t('settings.codexProvider.dialog.cliLoginAuthorizeTitle')}
            </div>
            <div className={sharedStyles.warningContent}>
              {t('settings.codexProvider.dialog.cliLoginAuthorizeMessage')}
              <br />
              <br />
              {t('settings.codexProvider.dialog.cliLoginAuthorizeDetail')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnSecondary}
                onClick={() => setShowCliLoginConfirm(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={sharedStyles.btnPrimary}
                onClick={() => {
                  setShowCliLoginConfirm(false);
                  onSwitchCodexProvider(SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN);
                }}
              >
                {t('settings.provider.authorizeAndEnable')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CLI Login disable confirm dialog */}
      {showCliLoginDisableConfirm && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-circle-slash" />
              {t('settings.codexProvider.dialog.cliLoginDisableTitle')}
            </div>
            <div className={sharedStyles.warningContent}>
              {t('settings.codexProvider.dialog.cliLoginDisableMessage')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnSecondary}
                onClick={() => setShowCliLoginDisableConfirm(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={sharedStyles.btnDanger}
                onClick={() => {
                  setShowCliLoginDisableConfirm(false);
                  const firstRegular = regularProviders[0];
                  onRevokeCodexLocalConfigAuthorization(firstRegular?.id);
                }}
              >
                {t('settings.provider.revokeAuthorization')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* cc-switch import confirm dialog */}
      {showImportDialog && (
        <ImportConfirmDialog
          providers={importPreviewData}
          existingProviders={codexProviders}
          onConfirm={(selectedProviders) => {
            sendToJava('save_imported_codex_providers', { providers: selectedProviders });
            setShowImportDialog(false);
          }}
          onCancel={() => setShowImportDialog(false)}
        />
      )}

      {/* Import loading */}
      {isImporting && (
        <div className={sharedStyles.loadingOverlay}>
          <div className={sharedStyles.loadingContent}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>{t('settings.provider.readingCcSwitch')}</span>
          </div>
        </div>
      )}

      {/* Edit cc-switch provider warning dialog */}
      {editingCcSwitchProvider && !convertingProvider && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-warning" />
              {t('settings.provider.editCcSwitchTitle')}
            </div>
            <div className={sharedStyles.warningContent}>
              {t('settings.provider.editCcSwitchWarning')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnSecondary}
                onClick={() => setEditingCcSwitchProvider(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={sharedStyles.btnSecondary}
                onClick={() => {
                  const p = editingCcSwitchProvider;
                  setEditingCcSwitchProvider(null);
                  onEditCodexProvider(p);
                }}
              >
                {t('settings.provider.continueEdit')}
              </button>
              <button
                className={sharedStyles.btnWarning}
                onClick={() => setConvertingProvider(editingCcSwitchProvider)}
              >
                {t('settings.provider.convertAndEdit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Convert-to-plugin confirmation dialog */}
      {convertingProvider && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-arrow-swap" />
              {t('settings.provider.convertToPlugin')}
            </div>
            <div className={sharedStyles.warningContent}>
              {t('settings.provider.convertConfirmMessage', { name: convertingProvider.name })}<br /><br />
              {t('settings.provider.convertDetailMessage')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnSecondary}
                onClick={() => {
                  setConvertingProvider(null);
                  // If triggered from editing, canceling conversion also cancels editing
                  if (editingCcSwitchProvider) {
                    setEditingCcSwitchProvider(null);
                  }
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                className={sharedStyles.btnPrimary}
                onClick={handleConvert}
              >
                {t('settings.provider.confirmConvert')}
              </button>
            </div>
          </div>
        </div>
      )}

      {codexLoading && (
        <div className={styles.tempNotice}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <p>{t('settings.provider.loading')}</p>
        </div>
      )}

      {!codexLoading && (
        <div className={styles.providerListContainer}>
          <div className={sharedStyles.header}>
            <h4 className={sharedStyles.title}>{t('settings.provider.allProviders')}</h4>
            <div className={sharedStyles.actions}>
              <div className={sharedStyles.importMenuWrapper} ref={importMenuRef}>
                <button
                  className={sharedStyles.btnSecondary}
                  onClick={() => setImportMenuOpen(!importMenuOpen)}
                >
                  <span className="codicon codicon-cloud-download" />
                  {t('settings.provider.import')}
                </button>

                {importMenuOpen && (
                  <div className={sharedStyles.importMenu}>
                    <div
                      className={sharedStyles.importMenuItem}
                      onClick={() => {
                        setImportMenuOpen(false);
                        setIsImporting(true); // Start loading
                        sendToJava('preview_codex_cc_switch_import');
                      }}
                    >
                      <span className="codicon codicon-arrow-swap" />
                      {t('settings.provider.importFromCcSwitchUpdate')}
                    </div>
                    <div
                      className={sharedStyles.importMenuItem}
                      onClick={handleSelectFileClick}
                    >
                      <span className="codicon codicon-file" />
                      {t('settings.provider.importFromCcSwitchFile')}
                    </div>
                  </div>
                )}
              </div>

              <button
                className={sharedStyles.btnPrimary}
                onClick={onAddCodexProvider}
              >
                <span className="codicon codicon-add" />
                {t('common.add')}
              </button>
            </div>
          </div>

          <div className={sharedStyles.list}>
            {/* CLI Login virtual provider card (pinned at top) */}
            {cliLoginProvider && (
              <div
                className={`${sharedStyles.card} ${isCliLoginActive ? sharedStyles.active : ''} ${sharedStyles.localProviderCard}`}
              >
                <div className={sharedStyles.cardInfo}>
                  <div className={sharedStyles.name}>
                    <span className="codicon codicon-key" style={ICON_MR_8_STYLE} />
                    {t('settings.codexProvider.dialog.cliLoginProviderName')}
                  </div>
                  <div className={sharedStyles.website} title={t('settings.codexProvider.dialog.cliLoginProviderDescription')}>
                    {t('settings.codexProvider.dialog.cliLoginProviderDescription')}
                  </div>
                  <div className={sharedStyles.website} style={CLI_LOGIN_NOTE_STYLE}>
                    {t('settings.codexProvider.dialog.cliLoginIsolationNote')}
                  </div>
                </div>

                <div className={sharedStyles.cardActions}>
                  {isCliLoginActive ? (
                    <button
                      className={sharedStyles.revokeButton}
                      onClick={() => setShowCliLoginDisableConfirm(true)}
                    >
                      <span className="codicon codicon-circle-slash" />
                      {t('settings.provider.revokeAuthorization')}
                    </button>
                  ) : (
                    <button
                      className={sharedStyles.useButton}
                      onClick={() => setShowCliLoginConfirm(true)}
                    >
                      <span className="codicon codicon-play" />
                      {t('settings.provider.authorizeAndEnable')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Regular providers (drag-sortable) */}
            {localProviders.length > 0 ? (
              localProviders.map((provider) => (
                <div
                  key={provider.id}
                  className={[
                    sharedStyles.card,
                    provider.isActive && sharedStyles.active,
                    draggedProviderId === provider.id && styles.dragging,
                    dragOverProviderId === provider.id && styles.dragOver,
                  ].filter(Boolean).join(' ')}
                  data-drag-sort-id={provider.id}
                  draggable={true}
                  onDragStart={(e) => handleDragStart(e, provider.id)}
                  onDragOver={(e) => handleDragOver(e, provider.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, provider.id)}
                  onDragEnd={handleDragEnd}
                >
                  <div
                    className={sharedStyles.dragHandle}
                    title={t('settings.provider.dragToSort')}
                    onPointerDown={(e) => handlePointerDown(e, provider.id, e.currentTarget.closest<HTMLElement>('[data-drag-sort-id]'))}
                  >
                    <span className="codicon codicon-gripper" />
                  </div>
                  <div className={sharedStyles.cardInfo}>
                    <div className={sharedStyles.name}>{provider.name}</div>
                    {provider.remark && (
                      <div className={sharedStyles.website}>{provider.remark}</div>
                    )}
                    {provider.source === 'cc-switch' && (
                      <div className={sharedStyles.ccSwitchBadge}>
                        cc-switch
                      </div>
                    )}
                  </div>

                  <div className={sharedStyles.cardActions}>
                    {provider.isActive ? (
                      <div className={sharedStyles.activeBadge}>
                        <span className="codicon codicon-check" />
                        {t('settings.provider.inUse')}
                      </div>
                    ) : (
                      <button
                        className={sharedStyles.useButton}
                        onClick={() => onSwitchCodexProvider(provider.id)}
                      >
                        <span className="codicon codicon-play" />
                        {t('settings.provider.enable')}
                      </button>
                    )}

                    <div className={sharedStyles.divider} />

                    <div className={sharedStyles.actionButtons}>
                      {provider.source === 'cc-switch' && (
                        <button
                          className={sharedStyles.iconBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConvertingProvider(provider);
                          }}
                          title={t('settings.provider.convertToPlugin')}
                        >
                          <span className="codicon codicon-arrow-swap" />
                        </button>
                      )}
                      <button
                        className={sharedStyles.iconBtn}
                        onClick={() => handleEditClick(provider)}
                        title={t('common.edit')}
                      >
                        <span className="codicon codicon-edit" />
                      </button>
                      <button
                        className={sharedStyles.iconBtn}
                        onClick={() => onDeleteCodexProvider(provider)}
                        title={t('common.delete')}
                      >
                        <span className="codicon codicon-trash" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : !cliLoginProvider ? (
              <div className={sharedStyles.emptyState}>
                <span className="codicon codicon-info" />
                <p>{t('settings.codexProvider.emptyProvider')}</p>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

export default CodexProviderSection;
