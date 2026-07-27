import { useCallback, useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ButtonAreaProps, ChatMode, CodexFastMode, ModelInfo, PermissionMode, ReasoningEffort } from './types';
import { ChatModeSelect, CodexFastModeSelect, ConfigSelect, ModelSelect, ModeSelect, ProviderSelect, QuickPromptSelect, ReasoningSelect, SubagentModelSelect } from './selectors';
import { STORAGE_KEYS } from '../../types/provider';
import { readClaudeModelMapping } from '../../utils/claudeModelMapping';
import { getProviderCapabilities, isKnownProvider } from '../../utils/providerCapabilities';
import { mergeModelLists } from '../../utils/availableModelsStore';
import { useAvailableModels } from '../../hooks/useAvailableModels';
import { useProviderCustomModels } from '../../hooks/useProviderCustomModels';

/**
 * ButtonArea - Bottom toolbar component
 * Contains mode selector, model selector, attachment button, prompt enhancer button, send/stop button
 */
export const ButtonArea = ({
  disabled = false,
  hasInputContent = false,
  isLoading = false,
  isEnhancing = false,
  selectedModel = 'claude-sonnet-4-6',
  permissionMode = 'default',
  currentProvider = 'claude',
  reasoningEffort = 'high',
  codexFastMode = 'normal',
  subagentModel = '',
  chatMode = 'agent',
  onSubmit,
  onStop,
  onModeSelect,
  onModelSelect,
  onProviderSelect,
  onReasoningChange,
  onCodexFastModeChange,
  onSubagentModelSelect,
  onChatModeSelect,
  onEnhancePrompt,
  onQuickPromptSelect,
  getInputText,
  alwaysThinkingEnabled = false,
  onToggleThinking,
  streamingEnabled = true,
  onStreamingEnabledChange,
  selectedAgent,
  onAgentSelect,
  onOpenAgentSettings,
  onAddModel,
  longContextEnabled = true,
  onLongContextChange,
}: ButtonAreaProps) => {
  const { t } = useTranslation();
  // const fileInputRef = useRef<HTMLInputElement>(null);

  const providerKind = isKnownProvider(currentProvider) ? currentProvider : 'claude';

  // Dynamic model list (backend-fetched, with built-in fallback) and the
  // active provider entry's custom models (legacy localStorage fallback).
  const { models: dynamicModels, refresh: refreshAvailableModels } = useAvailableModels(providerKind);
  const { models: providerCustomModels } = useProviderCustomModels(providerKind);

  // Track changes to the Claude model mapping in localStorage.
  // When localStorage changes, updating this version number triggers useMemo recalculation
  const [modelMappingVersion, setModelMappingVersion] = useState(0);

  // Listen for localStorage changes (cross-tab sync + same-tab custom events)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.CLAUDE_MODEL_MAPPING) {
        setModelMappingVersion(v => v + 1);
      }
    };

    // Listen for custom events (localStorage changes within the same tab)
    const handleCustomStorageChange = (e: CustomEvent<{ key: string }>) => {
      if (e.detail.key === STORAGE_KEYS.CLAUDE_MODEL_MAPPING) {
        setModelMappingVersion(v => v + 1);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('localStorageChange', handleCustomStorageChange as EventListener);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('localStorageChange', handleCustomStorageChange as EventListener);
    };
  }, []);

  /**
   * Apply model name mapping
   * Maps base model IDs to actual model names (e.g., versions with capacity suffixes)
   */
  const applyModelMapping = useCallback((model: ModelInfo, mapping: { main?: string; haiku?: string; sonnet?: string; opus?: string }): ModelInfo => {
    const modelKeyMap: Record<string, keyof typeof mapping> = {
      'claude-sonnet-5': 'sonnet',
      'claude-sonnet-4-6': 'sonnet',
      'claude-opus-4-8': 'opus',
      'claude-haiku-4-5': 'haiku',
    };

    const key = modelKeyMap[model.id];
    const resolvedMapping = (key ? mapping[key] : undefined) || mapping.main;
    if (resolvedMapping) {
      const actualModel = String(resolvedMapping).trim();
      if (actualModel.length > 0) {
        // Keep the original id as unique identifier, only modify label to custom name
        // This ensures id remains unique even if multiple models share the same displayName
        return { ...model, label: actualModel };
      }
    }
    return model;
  }, []);

  // Select model list based on current provider capabilities.
  // Three layers merged by id (earlier wins): the active provider entry's
  // custom models first, then the dynamic backend-fetched list, then the
  // built-in fallback list. modelMappingVersion triggers recalculation when
  // the Claude model mapping changes in localStorage.
  const availableModels = useMemo(() => {
    const capabilities = getProviderCapabilities(providerKind);

    // Dynamic models when available (source === 'dynamic'); the built-in list
    // stays as fallback for ids the dynamic list does not know about.
    let baseModels = mergeModelLists(dynamicModels, capabilities.models);
    if (capabilities.appliesModelMapping) {
      try {
        const mapping = readClaudeModelMapping();
        if (Object.keys(mapping).length > 0) {
          baseModels = baseModels.map((m) => applyModelMapping(m, mapping));
        }
      } catch {
        // ignore
      }
    }

    // Custom models are displayed before all others.
    const customModels: ModelInfo[] = providerCustomModels.map((m) => ({
      id: m.id,
      label: m.label || m.id,
      description: m.description,
    }));
    return mergeModelLists(customModels, baseModels);
  }, [providerKind, dynamicModels, providerCustomModels, applyModelMapping, modelMappingVersion]);

  /**
   * Handle submit button click
   */
  const handleSubmitClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSubmit?.();
  }, [onSubmit]);

  /**
   * Handle stop button click
   */
  const handleStopClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onStop?.();
  }, [onStop]);

  /**
   * Handle mode selection
   */
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    onModeSelect?.(mode);
  }, [onModeSelect]);

  /**
   * Handle model selection
   */
  const handleModelSelect = useCallback((modelId: string) => {
    onModelSelect?.(modelId);
  }, [onModelSelect]);

  /**
   * Handle provider selection
   */
  const handleProviderSelect = useCallback((providerId: string) => {
    onProviderSelect?.(providerId);
  }, [onProviderSelect]);

  /**
   * Handle reasoning depth selection
   */
  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    onReasoningChange?.(effort);
  }, [onReasoningChange]);

  /**
   * Handle Codex speed mode selection
   */
  const handleCodexFastModeChange = useCallback((mode: CodexFastMode) => {
    onCodexFastModeChange?.(mode);
  }, [onCodexFastModeChange]);

  /**
   * Handle subagent model selection ('' = default, follow the main model)
   */
  const handleSubagentModelSelect = useCallback((modelId: string) => {
    onSubagentModelSelect?.(modelId);
  }, [onSubagentModelSelect]);

  /**
   * Handle chat mode selection ('agent' = default; travels in the send payload)
   */
  const handleChatModeSelect = useCallback((mode: ChatMode) => {
    onChatModeSelect?.(mode);
  }, [onChatModeSelect]);

  /**
   * Handle enhance prompt button click
   */
  const handleEnhanceClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEnhancePrompt?.();
  }, [onEnhancePrompt]);

  return (
    <div className="button-area" data-provider={currentProvider}>
      {/* Left side: selectors */}
      <div className="button-area-left">
        <ConfigSelect
          alwaysThinkingEnabled={alwaysThinkingEnabled}
          onToggleThinking={onToggleThinking}
          streamingEnabled={streamingEnabled}
          onStreamingEnabledChange={onStreamingEnabledChange}
          selectedAgent={selectedAgent}
          onAgentSelect={onAgentSelect}
          onOpenAgentSettings={onOpenAgentSettings}
          currentProvider={currentProvider}
        />
        <ProviderSelect
          value={currentProvider}
          onChange={handleProviderSelect}
          compact
        />
        <ModeSelect value={permissionMode} onChange={handleModeSelect} provider={currentProvider} />
        <ChatModeSelect value={chatMode} onChange={handleChatModeSelect} provider={currentProvider} />
        <ModelSelect value={selectedModel} onChange={handleModelSelect} models={availableModels} currentProvider={currentProvider} onAddModel={onAddModel} longContextEnabled={longContextEnabled} onLongContextChange={onLongContextChange} onRefreshModels={refreshAvailableModels} />
        <SubagentModelSelect value={subagentModel} onChange={handleSubagentModelSelect} models={availableModels} currentProvider={currentProvider} />
        <ReasoningSelect value={reasoningEffort} onChange={handleReasoningChange} selectedModel={selectedModel} currentProvider={currentProvider} />
        {getProviderCapabilities(currentProvider).supportsServiceTier && (
          <CodexFastModeSelect value={codexFastMode} onChange={handleCodexFastModeChange} />
        )}
      </div>

      {/* Right side: tool buttons */}
      <div className="button-area-right">
        <div className="button-divider" />

        {/* Quick prompt presets */}
        {onQuickPromptSelect && (
          <QuickPromptSelect onSelect={onQuickPromptSelect} getInputText={getInputText} disabled={disabled || isLoading} />
        )}

        {/* Enhance prompt button */}
        <button
          className="enhance-prompt-button has-tooltip"
          onClick={handleEnhanceClick}
          disabled={disabled || !hasInputContent || isLoading || isEnhancing}
          data-tooltip={`${t('promptEnhancer.tooltip')} (${t('promptEnhancer.shortcut')})`}
        >
          <span className={`codicon ${isEnhancing ? 'codicon-loading codicon-modifier-spin' : 'codicon-sparkle'}`} />
        </button>

        {/* Send/Stop button */}
        {isLoading ? (
          <button
            className="submit-button stop-button"
            onClick={handleStopClick}
            title={t('chat.stopGeneration')}
          >
            <span className="codicon codicon-debug-stop" />
          </button>
        ) : (
          <button
            className="submit-button"
            onClick={handleSubmitClick}
            disabled={disabled || !hasInputContent}
            title={t('chat.sendMessageEnter')}
          >
            <span className="codicon codicon-send" />
          </button>
        )}
      </div>
    </div>
  );
};

export default ButtonArea;
