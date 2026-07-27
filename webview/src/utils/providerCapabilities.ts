/**
 * Provider capabilities — the single source of truth for "which provider
 * supports what" in the webview.
 *
 * Mirrors the Java-side `ProviderCapabilities` (provider/common/ProviderCapabilities.java)
 * flag set and extends it with the frontend-specific knowledge that used to be
 * scattered across components as `provider === 'claude' ? A : B` branches:
 * model list sources, reasoning effort sets, permission modes, message-sync
 * behaviors, bridge event names, and so on.
 *
 * Callers gate provider-specific behavior behind `getProviderCapabilities()`
 * or the semantic helpers below instead of comparing provider name strings.
 * The declaration table describes the CURRENT reality of each provider; in the
 * future it can be replaced (or overlaid) by capabilities pushed from the
 * backend without touching call sites.
 */

import {
  AVAILABLE_MODES,
  CLAUDE_MODELS,
  CODEX_MODELS,
  EFFORT_SUPPORTED_CLAUDE_MODELS,
  MAX_EFFORT_CLAUDE_MODELS,
  REASONING_LEVELS,
  XHIGH_EFFORT_CLAUDE_MODELS,
  normalizeClaudeModelId,
} from '../components/ChatInputBox/types';
import type { ModelInfo, PermissionMode, ReasoningInfo } from '../components/ChatInputBox/types';
import { STORAGE_KEYS, validateCodexCustomModels } from '../types/provider';
import type { ModelVendor } from './modelIconMapping';

/** The two provider kinds the webview can actually run. */
export type ProviderKind = 'claude' | 'codex';

/**
 * Reasoning-effort capabilities for a provider.
 * `model` is the currently selected model ID; it may be undefined when no
 * model has been resolved yet (selectors render before state hydration).
 */
export interface ReasoningCapabilities {
  /** Levels offered for the given model (already filtered per provider/model). */
  levelsForModel: (model?: string) => ReasoningInfo[];
  /** Whether the reasoning selector is shown / effort is sent for the model. */
  supportedForModel: (model?: string) => boolean;
}

/** Bridge events driving runtime (engine-level) provider switching. */
export interface RuntimeProviderEvents {
  /** Frontend → Java event requesting the provider list. */
  listEvent: string;
  /** Frontend → Java event switching the active provider. */
  switchEvent: string;
}

export interface ProviderCapabilities {
  // ── Backend capability flags (mirror Java ProviderCapabilities) ──

  /** Persistent daemon runtime that can be prewarmed/reset (Claude only). */
  supportsDaemon: boolean;
  /** Hot-swap permission mode on a live runtime mid-turn (Claude only). */
  supportsLivePermissionMode: boolean;
  /** Rewind files to a previous user message. */
  supportsRewind: boolean;
  /** Report a context-window usage breakdown (the /context command). */
  supportsContextUsage: boolean;
  /** Accept a service-tier selection on send (Codex "fast" tier). */
  supportsServiceTier: boolean;

  // ── Identity / display ──

  /** Proper-noun display name used in toasts and labels (not i18n'd). */
  displayName: string;
  /** Vendor icon key used as the model-icon fallback. */
  iconVendor: ModelVendor;
  /** codicon used for this provider's rows in the Node process panel. */
  processIcon: string;

  // ── Models ──

  /** Built-in model list — the fallback layer under the dynamic model list. */
  models: ModelInfo[];
  /**
   * @deprecated Legacy localStorage key for user-added custom models.
   * Custom models now live on the active provider entry (`customModels`) —
   * see utils/providerCustomModelsStore.ts. This key is kept only for the
   * read-only legacy fallback during the migration window.
   */
  customModelsStorageKey: string;
  /** Whether the Claude model-name mapping applies to built-in model labels. */
  appliesModelMapping: boolean;
  /** Normalize a model ID for storage/comparison (Claude aliases, [1m] strip). */
  normalizeModelId: (modelId: string | undefined | null) => string;
  /** Whether the 1M-context toggle is offered in the model selector. */
  supportsLongContext: boolean;
  /** Whether the subagent (Task tool) model selector is shown (Claude only). */
  supportsSubagentModel: boolean;
  /** Whether the per-message chat mode selector is shown (Claude only). */
  supportsChatMode: boolean;

  // ── Permission modes ──

  /** Permission modes offered by the mode selector, in display order. */
  permissionModes: PermissionMode[];
  /** i18n namespace for mode labels/descriptions. */
  modeLabelNamespace: 'modes' | 'codexModes';
  /** Whether plan mode exists (drives /plan handling and mode filtering). */
  supportsPlanMode: boolean;

  // ── Reasoning ──

  reasoning: ReasoningCapabilities;

  // ── Misc frontend features ──

  /** Whether `$` dollar-trigger completions are enabled in the input box. */
  supportsDollarTrigger: boolean;
  /** Whether provider rows offer the subscription-quota submenu. */
  supportsSubscriptionQuota: boolean;
  /** Whether configured-model pricing (settings.json models) is supported. */
  supportsConfiguredModelPricing: boolean;
  /** Whether the settings permissions tab shows a provider-specific panel. */
  supportsSandboxSettings: boolean;

  // ── Message-sync behaviors (hooks/windowCallbacks/messageSync.ts) ──

  /** Stream-end handling when no stream/turn is active. */
  idleStreamEndHandling: 'minimal' | 'skip';
  /** Strip duplicated trailing tool messages produced by session compaction. */
  stripsDuplicateTrailingToolMessages: boolean;
  /** Always preserve the tail when a backend snapshot shrinks (not only streaming tails). */
  alwaysPreservesShrinkTail: boolean;

  // ── Runtime provider switching ──

  runtimeProviderEvents: RuntimeProviderEvents;
}

const identityModelId = (modelId: string | undefined | null): string => modelId ?? '';

const ALL_PERMISSION_MODES: PermissionMode[] = AVAILABLE_MODES.map((mode) => mode.id);

const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  supportsDaemon: true,
  supportsLivePermissionMode: true,
  supportsRewind: true,
  supportsContextUsage: true,
  supportsServiceTier: false,

  displayName: 'Claude Code',
  iconVendor: 'claude',
  processIcon: 'codicon-server-process',

  models: CLAUDE_MODELS,
  customModelsStorageKey: STORAGE_KEYS.CLAUDE_CUSTOM_MODELS,
  appliesModelMapping: true,
  normalizeModelId: normalizeClaudeModelId,
  supportsLongContext: true,
  supportsSubagentModel: true,
  supportsChatMode: true,

  permissionModes: ALL_PERMISSION_MODES,
  modeLabelNamespace: 'modes',
  supportsPlanMode: true,

  reasoning: {
    // Claude gates xhigh/max per model; all other levels are always available.
    levelsForModel: (model) => REASONING_LEVELS.filter((level) => {
      if (!model) return true;
      if (level.id === 'xhigh') return XHIGH_EFFORT_CLAUDE_MODELS.has(model);
      if (level.id === 'max') return MAX_EFFORT_CLAUDE_MODELS.has(model);
      return true;
    }),
    supportedForModel: (model) => !model || EFFORT_SUPPORTED_CLAUDE_MODELS.has(model),
  },

  supportsDollarTrigger: false,
  supportsSubscriptionQuota: false,
  supportsConfiguredModelPricing: true,
  supportsSandboxSettings: false,

  idleStreamEndHandling: 'skip',
  stripsDuplicateTrailingToolMessages: false,
  alwaysPreservesShrinkTail: false,

  runtimeProviderEvents: { listEvent: 'get_providers', switchEvent: 'switch_provider' },
};

const CODEX_CAPABILITIES: ProviderCapabilities = {
  supportsDaemon: false,
  supportsLivePermissionMode: false,
  supportsRewind: false,
  supportsContextUsage: false,
  supportsServiceTier: true,

  displayName: 'Codex',
  iconVendor: 'openai',
  processIcon: 'codicon-comment-discussion',

  models: CODEX_MODELS,
  customModelsStorageKey: STORAGE_KEYS.CODEX_CUSTOM_MODELS,
  appliesModelMapping: false,
  normalizeModelId: identityModelId,
  supportsLongContext: false,
  supportsSubagentModel: false,
  supportsChatMode: false,

  // Codex supports default/acceptEdits/bypassPermissions; plan mode is not exposed.
  permissionModes: ALL_PERMISSION_MODES.filter((id) => id !== 'plan'),
  modeLabelNamespace: 'codexModes',
  supportsPlanMode: false,

  reasoning: {
    // Codex offers low/medium/high/xhigh for every model; 'max' is Claude-only.
    levelsForModel: () => REASONING_LEVELS.filter((level) => level.id !== 'max'),
    supportedForModel: () => true,
  },

  supportsDollarTrigger: true,
  supportsSubscriptionQuota: true,
  supportsConfiguredModelPricing: false,
  supportsSandboxSettings: true,

  // Codex compacts session history server-side: idle stream ends still need a
  // minimal sync, trailing tool messages can arrive duplicated, and shrunk
  // snapshots must always keep their in-memory tail.
  idleStreamEndHandling: 'minimal',
  stripsDuplicateTrailingToolMessages: true,
  alwaysPreservesShrinkTail: true,

  runtimeProviderEvents: { listEvent: 'get_codex_providers', switchEvent: 'switch_codex_provider' },
};

/**
 * Capabilities for an unrecognized provider ID. This is a per-field replica of
 * the legacy `provider === 'codex' ? A : B` else-branches so behavior for
 * unknown IDs stays exactly what it was before this module existed; the mix is
 * intentional (e.g. reasoning defaults to the non-Claude behavior while model
 * lists default to the Claude lists).
 */
const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  supportsDaemon: false,
  supportsLivePermissionMode: false,
  supportsRewind: false,
  supportsContextUsage: false,
  supportsServiceTier: false,

  displayName: 'Claude Code',
  iconVendor: 'claude',
  processIcon: 'codicon-debug-disconnect',

  models: CLAUDE_MODELS,
  customModelsStorageKey: STORAGE_KEYS.CLAUDE_CUSTOM_MODELS,
  appliesModelMapping: true,
  normalizeModelId: identityModelId,
  supportsLongContext: false,
  supportsSubagentModel: false,
  supportsChatMode: false,

  permissionModes: ALL_PERMISSION_MODES,
  modeLabelNamespace: 'modes',
  supportsPlanMode: false,

  reasoning: {
    levelsForModel: () => REASONING_LEVELS.filter((level) => level.id !== 'max'),
    supportedForModel: () => true,
  },

  supportsDollarTrigger: false,
  supportsSubscriptionQuota: false,
  supportsConfiguredModelPricing: false,
  supportsSandboxSettings: false,

  idleStreamEndHandling: 'skip',
  stripsDuplicateTrailingToolMessages: false,
  alwaysPreservesShrinkTail: false,

  runtimeProviderEvents: { listEvent: 'get_providers', switchEvent: 'switch_provider' },
};

const PROVIDER_CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
  claude: CLAUDE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
};

/** Whether the ID names a provider the webview can actually run. */
export function isKnownProvider(provider: unknown): provider is ProviderKind {
  return typeof provider === 'string' && Object.hasOwn(PROVIDER_CAPABILITIES, provider);
}

/**
 * Resolve the capabilities for a provider ID. Unknown IDs (including
 * undefined/null) return {@link DEFAULT_PROVIDER_CAPABILITIES}.
 */
export function getProviderCapabilities(provider: string | undefined | null): ProviderCapabilities {
  return isKnownProvider(provider) ? PROVIDER_CAPABILITIES[provider] : DEFAULT_PROVIDER_CAPABILITIES;
}

/**
 * Pick between the two per-provider state slices ("claude slice" vs "codex
 * slice"). Unknown providers resolve to the Claude slice, matching the legacy
 * else-branches.
 */
export function selectByProvider<T>(provider: string | undefined | null, slices: Record<ProviderKind, T>): T {
  return provider === 'codex' ? slices.codex : slices.claude;
}

// ---------------------------------------------------------------------------
// Semantic helpers
// ---------------------------------------------------------------------------

/** Proper-noun display name for toasts/labels ('Claude Code' / 'Codex'). */
export function providerDisplayName(provider: string | undefined | null): string {
  return getProviderCapabilities(provider).displayName;
}

/** Built-in (fallback) model list for the model selector. */
export function getAvailableModels(provider: string | undefined | null): ModelInfo[] {
  return getProviderCapabilities(provider).models;
}

/**
 * @deprecated Legacy localStorage key for user-added custom models.
 * Use utils/providerCustomModelsStore.ts (provider-entry-backed) instead.
 */
export function getCustomModelsStorageKey(provider: string | undefined | null): string {
  return getProviderCapabilities(provider).customModelsStorageKey;
}

/** Whether the reasoning selector is shown / effort is sent for the model. */
export function supportsReasoningEffort(provider: string | undefined | null, model?: string): boolean {
  return getProviderCapabilities(provider).reasoning.supportedForModel(model);
}

/** Reasoning levels offered for the given provider and model. */
export function getAvailableReasoningLevels(provider: string | undefined | null, model?: string): ReasoningInfo[] {
  return getProviderCapabilities(provider).reasoning.levelsForModel(model);
}

/** Whether plan mode exists for the provider (drives /plan handling). */
export function supportsPlanMode(provider: string | undefined | null): boolean {
  return getProviderCapabilities(provider).supportsPlanMode;
}

/** Whether the subagent (Task tool) model selector is shown for the provider. */
export function supportsSubagentModel(provider: string | undefined | null): boolean {
  return getProviderCapabilities(provider).supportsSubagentModel;
}

/** Whether the per-message chat mode selector is shown for the provider. */
export function supportsChatMode(provider: string | undefined | null): boolean {
  return getProviderCapabilities(provider).supportsChatMode;
}

/**
 * Clamp a permission mode to what the provider actually supports.
 * Today the only clamp is Codex mapping 'plan' → 'default'.
 */
export function sanitizePermissionMode(provider: string | undefined | null, mode: PermissionMode): PermissionMode {
  return getProviderCapabilities(provider).permissionModes.includes(mode) ? mode : 'default';
}

/**
 * Read the user-added custom model list for a provider from localStorage.
 *
 * @deprecated Legacy read path, kept for the read-only compatibility window
 * while custom models migrate to the provider entry (`customModels`). New
 * code should use utils/providerCustomModelsStore.ts.
 *
 * The two providers validate differently — Codex entries go through the strict
 * runtime validator while Claude entries keep the legacy lenient shape check —
 * because that is the shape each storage key has historically been written in.
 */
export function readProviderCustomModels(provider: string | undefined | null): ModelInfo[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }
  try {
    const stored = window.localStorage.getItem(getCustomModelsStorageKey(provider));
    if (!stored) {
      return [];
    }
    const parsed: unknown = JSON.parse(stored);
    if (provider === 'codex') {
      return validateCodexCustomModels(parsed).map((m) => ({
        id: m.id,
        label: m.label || m.id,
        description: m.description,
      }));
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    return (parsed as Array<{ id?: unknown; label?: string; description?: string }>)
      .filter((m): m is { id: string; label?: string; description?: string } =>
        !!m && typeof m === 'object' && typeof m.id === 'string' && m.id.trim().length > 0)
      .map((m) => ({
        id: m.id,
        label: m.label || m.id,
        description: m.description,
      }));
  } catch {
    return [];
  }
}
