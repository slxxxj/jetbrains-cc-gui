import { useCallback, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import { apply1MContextSuffix } from '../components/ChatInputBox/types';
import type { PermissionMode } from '../components/ChatInputBox/types';
import { isSpecialProviderId } from '../types/provider';
import {
  getProviderCapabilities,
  isKnownProvider,
  sanitizePermissionMode,
  selectByProvider,
} from '../utils/providerCapabilities';
import { useClaudeProvider } from './providers/useClaudeProvider';
import { useCodexProvider } from './providers/useCodexProvider';
import { useUsageTracking } from './providers/useUsageTracking';
import { useProviderSettings } from './providers/useProviderSettings';
import { useModelStatePersistence } from './providers/useModelStatePersistence';

export type ViewMode = 'chat' | 'history' | 'settings';

export interface UseModelProviderStateOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/**
 * Orchestrates provider/model/permission state. Composes four single-purpose
 * sub-hooks (Claude / Codex / usage tracking / provider settings) plus a
 * persistence hook, then wires the cross-slice state (currentProvider +
 * permissionMode) and the cross-provider handlers (mode/model/provider switch,
 * long-context toggle, always-thinking toggle).
 *
 * The flat return shape is preserved as the public API: callers (App,
 * ChatScreen, AppDialogs, useMessageSender) destructure individual fields.
 *
 * `currentProviderRef` is exposed for window callbacks registered with stable
 * identity that must read the current provider when fired by the JCEF bridge.
 * The ref is updated via render-time assignment (no useEffect mirror).
 */
export function useModelProviderState({ addToast, t }: UseModelProviderStateOptions) {
  // ── Cross-slice state owned by the orchestrator ──
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  // External-facing ref so window callbacks can read the latest provider
  // without re-binding. Render-time assignment avoids the useRef + useEffect
  // mirror anti-pattern (rule 5.15).
  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;

  // ── Provider-specific sub-hooks ──
  const claude = useClaudeProvider();
  const codex = useCodexProvider();
  const { isSdkInstalled, ...usage } = useUsageTracking();
  const settings = useProviderSettings({ addToast, t });

  const {
    selectedClaudeModel, setSelectedClaudeModel,
    claudePermissionMode, setClaudePermissionMode,
    longContextEnabled, setLongContextEnabled,
    setClaudeSettingsAlwaysThinkingEnabled,
    selectedSubagentModel, setSelectedSubagentModel,
  } = claude;
  const {
    selectedCodexModel, setSelectedCodexModel,
    codexPermissionMode, setCodexPermissionMode,
    reasoningEffort, setReasoningEffort,
    codexFastMode, setCodexFastMode,
  } = codex;

  // ── Persistence: load on mount + save on change ──
  useModelStatePersistence({
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setCodexFastMode,
    setSelectedSubagentModel,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
    selectedSubagentModel,
  });

  // ── Computed values ──
  const selectedModel = selectByProvider(currentProvider, {
    claude: selectedClaudeModel,
    codex: selectedCodexModel,
  });
  const currentSdkInstalled = useMemo(
    () => isSdkInstalled(currentProvider),
    [isSdkInstalled, currentProvider],
  );

  // ── Cross-provider handlers ──
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    const nextMode = sanitizePermissionMode(currentProvider, mode);
    setPermissionMode(nextMode);
    selectByProvider(currentProvider, {
      claude: setClaudePermissionMode,
      codex: setCodexPermissionMode,
    })(nextMode);
    sendBridgeEvent('set_mode', nextMode);
  }, [currentProvider, setCodexPermissionMode, setClaudePermissionMode]);

  const handleModelSelect = useCallback((modelId: string) => {
    if (!isKnownProvider(currentProvider)) {
      return;
    }
    const capabilities = getProviderCapabilities(currentProvider);
    const normalizedModelId = capabilities.normalizeModelId(modelId);
    selectByProvider(currentProvider, {
      claude: setSelectedClaudeModel,
      codex: setSelectedCodexModel,
    })(normalizedModelId);
    sendBridgeEvent('set_model', capabilities.supportsLongContext
      ? apply1MContextSuffix(normalizedModelId, longContextEnabled)
      : normalizedModelId);
  }, [currentProvider, longContextEnabled, setSelectedClaudeModel, setSelectedCodexModel]);

  const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);

    const capabilities = getProviderCapabilities(providerId);
    const modeToSet = sanitizePermissionMode(providerId, selectByProvider(providerId, {
      claude: claudePermissionMode,
      codex: codexPermissionMode,
    }));
    setPermissionMode(modeToSet);
    sendBridgeEvent('set_mode', modeToSet);

    const newModel = selectByProvider(providerId, {
      claude: selectedClaudeModel,
      codex: selectedCodexModel,
    });
    sendBridgeEvent('set_model', capabilities.supportsLongContext
      ? apply1MContextSuffix(newModel, longContextEnabled)
      : newModel);
  }, [
    claudePermissionMode,
    codexPermissionMode,
    selectedCodexModel,
    selectedClaudeModel,
    longContextEnabled,
  ]);

  const handleLongContextChange = useCallback((enabled: boolean) => {
    setLongContextEnabled(enabled);
    if (getProviderCapabilities(currentProvider).supportsLongContext) {
      sendBridgeEvent('set_model', apply1MContextSuffix(selectedClaudeModel, enabled));
    }
  }, [currentProvider, selectedClaudeModel, setLongContextEnabled]);

  // Subagent model is Claude-only state that travels per request inside the
  // send_message payload — no immediate bridge event is needed (unlike the
  // main model, which the backend tracks via set_model). '' = default.
  const handleSubagentModelSelect = useCallback((modelId: string) => {
    setSelectedSubagentModel(modelId);
  }, [setSelectedSubagentModel]);

  const handleToggleThinking = useCallback((enabled: boolean) => {
    const config = settings.activeProviderConfig;
    const isSpecialProvider = isSpecialProviderId(config?.id || '');

    setClaudeSettingsAlwaysThinkingEnabled(enabled);

    if (!config || isSpecialProvider) {
      settings.setActiveProviderConfig(prev => prev ? {
        ...prev,
        settingsConfig: {
          ...prev.settingsConfig,
          alwaysThinkingEnabled: enabled,
        },
      } : prev);
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    settings.setActiveProviderConfig(prev => prev ? {
      ...prev,
      settingsConfig: {
        ...prev.settingsConfig,
        alwaysThinkingEnabled: enabled,
      },
    } : null);

    sendBridgeEvent('update_provider', JSON.stringify({
      id: config.id,
      updates: {
        settingsConfig: {
          ...(config.settingsConfig || {}),
          alwaysThinkingEnabled: enabled,
        },
      },
    }));
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  }, [settings, setClaudeSettingsAlwaysThinkingEnabled, addToast, t]);

  return {
    ...claude,
    ...codex,
    ...usage,
    ...settings,
    currentProvider, setCurrentProvider,
    permissionMode, setPermissionMode,
    selectedModel,
    currentSdkInstalled,
    currentProviderRef,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleLongContextChange,
    handleToggleThinking,
    handleSubagentModelSelect,
  };
}
