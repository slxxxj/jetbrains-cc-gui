import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import type { CommitAiConfig, CommitAiProvider } from '../../../types/aiFeatureConfig';
import { DEFAULT_COMMIT_AI_CONFIG } from '../../../types/aiFeatureConfig';
import AiFeatureProviderModelPanel from '../AiFeatureProviderModelPanel';
import AiFeatureSettingsCard from '../AiFeatureSettingsCard';
import { useCommitAgentConfig } from './useCommitAgentConfig';

interface CommitSectionProps {
  commitAiConfig?: CommitAiConfig;
  onCommitAiProviderChange?: (provider: CommitAiProvider) => void;
  onCommitAiModelChange?: (model: string) => void;
  onCommitAiResetToDefault?: () => void;
  commitPrompt: string;
  projectCommitPrompt: string;
  onCommitPromptChange: (prompt: string) => void;
  onProjectCommitPromptChange: (prompt: string) => void;
  onSaveCommitPrompt: () => void;
  onSaveProjectCommitPrompt: () => void;
  savingCommitPrompt: boolean;
  savingProjectCommitPrompt: boolean;
}

const CommitSection = ({
  commitAiConfig = DEFAULT_COMMIT_AI_CONFIG,
  onCommitAiProviderChange = () => {},
  onCommitAiModelChange = () => {},
  onCommitAiResetToDefault = () => {},
  commitPrompt,
  projectCommitPrompt,
  onCommitPromptChange,
  onProjectCommitPromptChange,
  onSaveCommitPrompt,
  onSaveProjectCommitPrompt,
  savingCommitPrompt,
  savingProjectCommitPrompt,
}: CommitSectionProps) => {
  const { t } = useTranslation();
  const {
    config: agentConfig,
    updateBatchSize,
    updateMaxParallel,
    updateFastMode,
    updateIncludeFileDetail,
  } = useCommitAgentConfig();

  return (
    <div className={styles.configSection}>
      <AiFeatureSettingsCard
        title={t('settings.commit.title')}
        description={t('settings.commit.description')}
        testId="commit-ai-provider-card"
      >
        <AiFeatureProviderModelPanel
          config={commitAiConfig}
          settingsKeyPrefix="settings.commit.providerModel"
          providerKeyPrefix="settings.basic.promptEnhancer.provider"
          fallbackProvider="codex"
          onProviderChange={onCommitAiProviderChange}
          onModelChange={onCommitAiModelChange}
          onResetToDefault={onCommitAiResetToDefault}
        />
      </AiFeatureSettingsCard>

      {/* Parallel agents for large change sets */}
      <div className={styles.promptSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-rocket" />
          <span className={styles.fieldLabel}>{t('settings.commit.agentConfig.label')}</span>
        </div>
        <div className={styles.agentConfigRow}>
          <label className={styles.agentConfigLabel} htmlFor="commit-agent-batch-size">
            {t('settings.commit.agentConfig.batchSize')}
          </label>
          <input
            id="commit-agent-batch-size"
            className={styles.agentNumberInput}
            type="number"
            min={1}
            max={50}
            value={agentConfig.batchSize}
            onChange={(e) => updateBatchSize(Number(e.target.value))}
          />
        </div>
        <div className={styles.agentConfigRow}>
          <label className={styles.agentConfigLabel} htmlFor="commit-agent-max-parallel">
            {t('settings.commit.agentConfig.maxParallel')}
          </label>
          <input
            id="commit-agent-max-parallel"
            className={styles.agentNumberInput}
            type="number"
            min={1}
            max={16}
            value={agentConfig.maxParallel}
            onChange={(e) => updateMaxParallel(Number(e.target.value))}
          />
        </div>
        <div className={styles.agentConfigRow}>
          <label className={styles.agentConfigLabel} htmlFor="commit-fast-mode">
            {t('settings.commit.agentConfig.fastMode')}
          </label>
          <input
            id="commit-fast-mode"
            type="checkbox"
            checked={agentConfig.fastMode}
            onChange={(e) => updateFastMode(e.target.checked)}
          />
        </div>
        <div className={styles.agentConfigRow}>
          <label className={styles.agentConfigLabel} htmlFor="commit-include-file-detail">
            {t('settings.commit.agentConfig.includeFileDetail')}
          </label>
          <input
            id="commit-include-file-detail"
            type="checkbox"
            checked={agentConfig.includeFileDetail}
            onChange={(e) => updateIncludeFileDetail(e.target.checked)}
          />
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.commit.agentConfig.hint')}</span>
        </small>
      </div>

      {/* Commit AI prompt configuration */}
      <div className={styles.promptSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-edit" />
          <span className={styles.fieldLabel}>{t('settings.commit.prompt.label')}</span>
        </div>
        <div className={styles.promptInputWrapper}>
          <textarea
            className={styles.promptTextarea}
            placeholder={t('settings.commit.prompt.placeholder')}
            value={commitPrompt}
            onChange={(e) => onCommitPromptChange(e.target.value)}
            rows={6}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveCommitPrompt}
            disabled={savingCommitPrompt}
          >
            {savingCommitPrompt && (
              <span className="codicon codicon-loading codicon-modifier-spin" />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.commit.prompt.hint')}</span>
        </small>
      </div>

      {/* Project-level commit prompt configuration */}
      <div className={styles.promptSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-folder" />
          <span className={styles.fieldLabel}>{t('settings.commit.projectPrompt.label')}</span>
        </div>
        <div className={styles.promptInputWrapper}>
          <textarea
            className={styles.promptTextarea}
            placeholder={t('settings.commit.projectPrompt.placeholder')}
            value={projectCommitPrompt}
            onChange={(e) => onProjectCommitPromptChange(e.target.value)}
            rows={6}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveProjectCommitPrompt}
            disabled={savingProjectCommitPrompt}
          >
            {savingProjectCommitPrompt && (
              <span className="codicon codicon-loading codicon-modifier-spin" />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.commit.projectPrompt.hint')}</span>
        </small>
      </div>
    </div>
  );
};

export default CommitSection;
