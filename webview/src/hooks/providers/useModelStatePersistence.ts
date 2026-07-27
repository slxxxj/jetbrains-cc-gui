import { useEffect } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import {
  isValidChatMode,
  isValidPermissionMode,
  apply1MContextSuffix,
} from '../../components/ChatInputBox/types';
import type { ChatMode, CodexFastMode, PermissionMode, ReasoningEffort } from '../../components/ChatInputBox/types';
import {
  getAvailableModels,
  getProviderCapabilities,
  isKnownProvider,
  sanitizePermissionMode,
  selectByProvider,
} from '../../utils/providerCapabilities';

const STORAGE_KEY = 'model-selection-state';
const REASONING_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX_FAST_MODE_VALUES = ['normal', 'fast'] as const;

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && (REASONING_VALUES as readonly string[]).includes(value);

const isCodexFastMode = (value: unknown): value is CodexFastMode =>
  typeof value === 'string' && (CODEX_FAST_MODE_VALUES as readonly string[]).includes(value);

export interface UseModelStatePersistenceOptions {
  // Cross-slice load setters (run once on mount)
  setCurrentProvider: (value: string) => void;
  setSelectedClaudeModel: (value: string) => void;
  setSelectedCodexModel: (value: string) => void;
  setClaudePermissionMode: (value: PermissionMode) => void;
  setCodexPermissionMode: (value: PermissionMode) => void;
  setPermissionMode: (value: PermissionMode) => void;
  setLongContextEnabled: (value: boolean) => void;
  setReasoningEffort: (value: ReasoningEffort) => void;
  setCodexFastMode: (value: CodexFastMode) => void;
  setSelectedSubagentModel: (value: string) => void;
  setSelectedChatMode: (value: ChatMode) => void;
  // Cross-slice save deps (re-saves on any change)
  currentProvider: string;
  selectedClaudeModel: string;
  selectedCodexModel: string;
  claudePermissionMode: PermissionMode;
  codexPermissionMode: PermissionMode;
  longContextEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  codexFastMode: CodexFastMode;
  selectedSubagentModel: string;
  selectedChatMode: ChatMode;
}

/**
 * Two effects for persisting cross-slice provider/model state to localStorage:
 *  1. On mount: hydrate state from localStorage and sync the restored values
 *     to the backend (retrying until the JCEF bridge is ready).
 *  2. On change: re-save the snapshot to localStorage.
 *
 * Save uses `JSON.stringify` of the persisted keys; load applies
 * defensive validation (permission mode allowlist, reasoning effort
 * allowlist) before invoking the slice setters. Model ids are restored
 * verbatim — unknown ids are tolerated (dynamic model lists and entry-level
 * custom models load asynchronously).
 */
export function useModelStatePersistence(options: UseModelStatePersistenceOptions) {
  const {
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
    setSelectedChatMode,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
    selectedSubagentModel,
    selectedChatMode,
  } = options;

  // Hydrate from localStorage and sync to backend (mount only).
  // Setters are stable; deps left empty to ensure single execution.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // Per-tab restore (issue #1353): when the Java backend has loaded a saved
      // session for this specific tab, it injects __INITIAL_TAB_PROVIDER__ /
      // __INITIAL_TAB_MODEL__ into the HTML before React boots. Those values
      // win over the global localStorage snapshot, which is shared across every
      // tab in the JCEF process and would otherwise cause every CC tab on
      // restart to be set to whichever provider was last saved by ANY tab.
      const initialTabProvider = typeof window.__INITIAL_TAB_PROVIDER__ === 'string'
        ? window.__INITIAL_TAB_PROVIDER__.trim()
        : '';
      const initialTabModel = typeof window.__INITIAL_TAB_MODEL__ === 'string'
        ? window.__INITIAL_TAB_MODEL__.trim()
        : '';
      const hasBackendProvider = isKnownProvider(initialTabProvider);
      const hasBackendModel = initialTabModel.length > 0;

      let restoredProvider = 'claude';
      let restoredClaudeModel = getAvailableModels('claude')[0].id;
      let restoredCodexModel = getAvailableModels('codex')[0].id;
      let restoredClaudePermissionMode: PermissionMode = 'default';
      let restoredCodexPermissionMode: PermissionMode = 'default';
      let restoredLongContextEnabled = true;
      let restoredCodexFastMode: CodexFastMode = 'normal';

      // Model validation helper — closes over the restored* lets so both
      // branches (saved localStorage / fresh backend-only) share the same logic.
      // Unknown model ids are accepted as-is: the dynamic model list and the
      // provider entry's custom models are only available asynchronously, so
      // rejecting ids missing from the built-in list would clobber valid
      // selections on every boot.
      const applyRestoredModel = (provider: string, savedModel: string | undefined) => {
        const capabilities = getProviderCapabilities(provider);
        const candidate = hasBackendModel && restoredProvider === provider
          ? initialTabModel
          : savedModel;
        const normalized = capabilities.normalizeModelId(candidate);
        if (!normalized) {
          return;
        }
        selectByProvider(provider, {
          claude: (id: string) => {
            restoredClaudeModel = id;
            setSelectedClaudeModel(id);
          },
          codex: (id: string) => {
            restoredCodexModel = id;
            setSelectedCodexModel(id);
          },
        })(normalized);
      };

      if (saved) {
        const state = JSON.parse(saved);

        // Backend-supplied provider wins. We still fall through the rest of the
        // hydration so non-provider preferences (permission mode, reasoning
        // effort, codex fast mode, …) are restored from localStorage.
        const providerCandidate = hasBackendProvider ? initialTabProvider : state.provider;
        if (isKnownProvider(providerCandidate)) {
          restoredProvider = providerCandidate;
          setCurrentProvider(providerCandidate);
        }

        if (isValidPermissionMode(state.claudePermissionMode)) {
          restoredClaudePermissionMode = state.claudePermissionMode;
        }
        if (isValidPermissionMode(state.codexPermissionMode)) {
          restoredCodexPermissionMode = sanitizePermissionMode('codex', state.codexPermissionMode);
        }

        if (typeof state.longContextEnabled === 'boolean') {
          restoredLongContextEnabled = state.longContextEnabled;
          setLongContextEnabled(state.longContextEnabled);
        }

        if (isReasoningEffort(state.reasoningEffort)) {
          setReasoningEffort(state.reasoningEffort);
        }
        if (isCodexFastMode(state.codexFastMode)) {
          restoredCodexFastMode = state.codexFastMode;
          setCodexFastMode(restoredCodexFastMode);
        }

        // Subagent model ids are restored verbatim — like model ids, unknown
        // values are tolerated because the dynamic model list loads async.
        // '' means "no override" and is the default when the key is absent.
        if (typeof state.claudeSubagentModel === 'string') {
          setSelectedSubagentModel(state.claudeSubagentModel);
        }

        // Chat mode is validated against the allowlist; anything unrecognized
        // falls back to the 'agent' default already held by the slice hook.
        if (isValidChatMode(state.claudeChatMode)) {
          setSelectedChatMode(state.claudeChatMode);
        }

        applyRestoredModel('claude', state.claudeModel);
        applyRestoredModel('codex', state.codexModel);
      } else if (hasBackendProvider) {
        // No localStorage yet (fresh user) but backend supplied a provider:
        // honor it so the tab starts with the right provider.
        restoredProvider = initialTabProvider;
        setCurrentProvider(initialTabProvider);
        if (hasBackendModel) {
          applyRestoredModel(initialTabProvider, initialTabModel);
        }
      }

      const initialPermissionMode: PermissionMode = selectByProvider(restoredProvider, {
        claude: restoredClaudePermissionMode,
        codex: restoredCodexPermissionMode,
      });
      setClaudePermissionMode(restoredClaudePermissionMode);
      setCodexPermissionMode(restoredCodexPermissionMode);
      setPermissionMode(initialPermissionMode);

      let syncRetryCount = 0;
      const MAX_SYNC_RETRIES = 30;

      const syncToBackend = () => {
        if (window.sendToJava) {
          sendBridgeEvent('set_provider', restoredProvider);
          const restoredModel = selectByProvider(restoredProvider, {
            claude: restoredClaudeModel,
            codex: restoredCodexModel,
          });
          const modelToSync = getProviderCapabilities(restoredProvider).supportsLongContext
            ? apply1MContextSuffix(restoredModel, restoredLongContextEnabled)
            : restoredModel;
          sendBridgeEvent('set_model', modelToSync);
          // Do NOT push the permission mode to Java on boot. Java is the source
          // of truth for the mode (persisted app-level in PropertiesComponent,
          // which survives a plugin reinstall) and the webview seeds its own mode
          // FROM Java via get_mode → onModeReceived. Our localStorage copy is
          // wiped on reinstall, so pushing it here would clobber the surviving
          // Java value with 'default' — the reported "reinstall forgets Auto" bug.
          // The mode is only sent to Java on an explicit user switch
          // (handleModeSelect → set_mode).
          sendBridgeEvent('set_codex_fast_mode', restoredCodexFastMode);
        } else {
          syncRetryCount++;
          if (syncRetryCount < MAX_SYNC_RETRIES) {
            setTimeout(syncToBackend, 100);
          }
        }
      };
      setTimeout(syncToBackend, 200);
    } catch {
      // Failed to load model selection state — fall back to defaults already
      // set by individual slice hooks.
    }
  }, []);

  // Persist snapshot whenever any of the persisted keys change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        provider: currentProvider,
        claudeModel: selectedClaudeModel,
        codexModel: selectedCodexModel,
        claudePermissionMode,
        codexPermissionMode,
        longContextEnabled,
        reasoningEffort,
        codexFastMode,
        claudeSubagentModel: selectedSubagentModel,
        claudeChatMode: selectedChatMode,
      }));
    } catch {
      // Failed to save model selection state — non-fatal.
    }
  }, [
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
    selectedSubagentModel,
    selectedChatMode,
  ]);
}
