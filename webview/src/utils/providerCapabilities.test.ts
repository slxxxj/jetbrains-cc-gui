import { beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_MODELS, CODEX_MODELS } from '../components/ChatInputBox/types';
import { STORAGE_KEYS } from '../types/provider';
import {
  getAvailableModels,
  getAvailableReasoningLevels,
  getCustomModelsStorageKey,
  getProviderCapabilities,
  isKnownProvider,
  providerDisplayName,
  readProviderCustomModels,
  sanitizePermissionMode,
  selectByProvider,
  supportsPlanMode,
  supportsReasoningEffort,
} from './providerCapabilities';

describe('getProviderCapabilities', () => {
  it('declares the Java-side flag set for Claude (daemon/live mode/rewind/context usage, no service tier)', () => {
    const caps = getProviderCapabilities('claude');
    expect(caps.supportsDaemon).toBe(true);
    expect(caps.supportsLivePermissionMode).toBe(true);
    expect(caps.supportsRewind).toBe(true);
    expect(caps.supportsContextUsage).toBe(true);
    expect(caps.supportsServiceTier).toBe(false);
  });

  it('declares the Java-side flag set for Codex (service tier only)', () => {
    const caps = getProviderCapabilities('codex');
    expect(caps.supportsDaemon).toBe(false);
    expect(caps.supportsLivePermissionMode).toBe(false);
    expect(caps.supportsRewind).toBe(false);
    expect(caps.supportsContextUsage).toBe(false);
    expect(caps.supportsServiceTier).toBe(true);
  });

  it('falls back to the default declaration for unknown providers', () => {
    const caps = getProviderCapabilities('gemini');
    expect(caps).toBe(getProviderCapabilities(undefined));
    expect(caps).toBe(getProviderCapabilities(null));
    expect(caps.supportsRewind).toBe(false);
    expect(caps.supportsContextUsage).toBe(false);
    expect(caps.displayName).toBe('Claude Code');
    expect(caps.models).toBe(CLAUDE_MODELS);
    expect(caps.permissionModes).toEqual(['default', 'plan', 'acceptEdits', 'bypassPermissions']);
  });

  it('returns stable object references for repeated lookups', () => {
    expect(getProviderCapabilities('claude')).toBe(getProviderCapabilities('claude'));
    expect(getProviderCapabilities('codex')).toBe(getProviderCapabilities('codex'));
  });
});

describe('isKnownProvider', () => {
  it('accepts the two runtime providers', () => {
    expect(isKnownProvider('claude')).toBe(true);
    expect(isKnownProvider('codex')).toBe(true);
  });

  it('rejects unknown and non-string values', () => {
    expect(isKnownProvider('gemini')).toBe(false);
    expect(isKnownProvider('')).toBe(false);
    expect(isKnownProvider(undefined)).toBe(false);
    expect(isKnownProvider(null)).toBe(false);
    expect(isKnownProvider(42)).toBe(false);
    // Prototype-chain names must not count as known providers.
    expect(isKnownProvider('constructor')).toBe(false);
  });
});

describe('selectByProvider', () => {
  const slices = { claude: 'claude-slice', codex: 'codex-slice' };

  it('picks the matching slice for known providers', () => {
    expect(selectByProvider('claude', slices)).toBe('claude-slice');
    expect(selectByProvider('codex', slices)).toBe('codex-slice');
  });

  it('defaults to the Claude slice for unknown providers', () => {
    expect(selectByProvider('gemini', slices)).toBe('claude-slice');
    expect(selectByProvider(undefined, slices)).toBe('claude-slice');
  });
});

describe('display helpers', () => {
  it('resolves proper-noun display names', () => {
    expect(providerDisplayName('claude')).toBe('Claude Code');
    expect(providerDisplayName('codex')).toBe('Codex');
    expect(providerDisplayName('unknown')).toBe('Claude Code');
  });

  it('resolves built-in model lists', () => {
    expect(getAvailableModels('claude')).toBe(CLAUDE_MODELS);
    expect(getAvailableModels('codex')).toBe(CODEX_MODELS);
    expect(getAvailableModels('unknown')).toBe(CLAUDE_MODELS);
  });

  it('resolves custom-model storage keys', () => {
    expect(getCustomModelsStorageKey('claude')).toBe(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS);
    expect(getCustomModelsStorageKey('codex')).toBe(STORAGE_KEYS.CODEX_CUSTOM_MODELS);
    expect(getCustomModelsStorageKey('unknown')).toBe(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS);
  });
});

describe('model id normalization', () => {
  it('normalizes Claude model ids (strips [1m], maps legacy aliases)', () => {
    const normalize = getProviderCapabilities('claude').normalizeModelId;
    expect(normalize('claude-opus-4-6[1m]')).toBe('claude-opus-4-6');
    expect(normalize('claude-sonnet-5[1m]')).toBe('claude-sonnet-5');
    expect(normalize(undefined)).toBe('claude-sonnet-4-6');
  });

  it('keeps Codex model ids untouched', () => {
    const normalize = getProviderCapabilities('codex').normalizeModelId;
    expect(normalize('gpt-5.5')).toBe('gpt-5.5');
    expect(normalize(undefined)).toBe('');
  });
});

describe('permission modes', () => {
  it('excludes plan mode for Codex and keeps it for Claude', () => {
    expect(getProviderCapabilities('claude').permissionModes).toContain('plan');
    expect(getProviderCapabilities('codex').permissionModes).not.toContain('plan');
    expect(getProviderCapabilities('codex').permissionModes).toEqual([
      'default',
      'acceptEdits',
      'bypassPermissions',
    ]);
  });

  it('sanitizes plan mode to default only for providers without plan support', () => {
    expect(sanitizePermissionMode('codex', 'plan')).toBe('default');
    expect(sanitizePermissionMode('codex', 'acceptEdits')).toBe('acceptEdits');
    expect(sanitizePermissionMode('claude', 'plan')).toBe('plan');
    expect(sanitizePermissionMode('unknown', 'plan')).toBe('plan');
  });

  it('exposes plan-mode support as a capability', () => {
    expect(supportsPlanMode('claude')).toBe(true);
    expect(supportsPlanMode('codex')).toBe(false);
    expect(supportsPlanMode('unknown')).toBe(false);
  });

  it('uses the codexModes i18n namespace only for Codex', () => {
    expect(getProviderCapabilities('claude').modeLabelNamespace).toBe('modes');
    expect(getProviderCapabilities('codex').modeLabelNamespace).toBe('codexModes');
  });
});

describe('reasoning effort', () => {
  it('is always supported for Codex and model-dependent for Claude', () => {
    expect(supportsReasoningEffort('codex', 'gpt-5.5')).toBe(true);
    expect(supportsReasoningEffort('codex')).toBe(true);
    expect(supportsReasoningEffort('claude', 'claude-opus-4-8')).toBe(true);
    expect(supportsReasoningEffort('claude', 'claude-haiku-4-5')).toBe(false);
    expect(supportsReasoningEffort('claude')).toBe(true);
    // Unknown providers keep the legacy non-Claude behavior.
    expect(supportsReasoningEffort('unknown', 'anything')).toBe(true);
  });

  it('offers low..xhigh for Codex (no max)', () => {
    const ids = getAvailableReasoningLevels('codex', 'gpt-5.5').map((l) => l.id);
    expect(ids).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('gates xhigh/max per Claude model', () => {
    expect(getAvailableReasoningLevels('claude', 'claude-opus-4-8').map((l) => l.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getAvailableReasoningLevels('claude', 'claude-sonnet-4-6').map((l) => l.id))
      .toEqual(['low', 'medium', 'high', 'max']);
    expect(getAvailableReasoningLevels('claude', 'claude-haiku-4-5').map((l) => l.id))
      .toEqual(['low', 'medium', 'high']);
    expect(getAvailableReasoningLevels('claude').map((l) => l.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('misc feature flags', () => {
  it('declares long-context / dollar-trigger / quota / pricing / sandbox support', () => {
    const claude = getProviderCapabilities('claude');
    const codex = getProviderCapabilities('codex');
    expect(claude.supportsLongContext).toBe(true);
    expect(codex.supportsLongContext).toBe(false);
    expect(claude.supportsDollarTrigger).toBe(false);
    expect(codex.supportsDollarTrigger).toBe(true);
    expect(claude.supportsSubscriptionQuota).toBe(false);
    expect(codex.supportsSubscriptionQuota).toBe(true);
    expect(claude.supportsConfiguredModelPricing).toBe(true);
    expect(codex.supportsConfiguredModelPricing).toBe(false);
    expect(claude.supportsSandboxSettings).toBe(false);
    expect(codex.supportsSandboxSettings).toBe(true);
    expect(claude.appliesModelMapping).toBe(true);
    expect(codex.appliesModelMapping).toBe(false);
  });

  it('declares message-sync behaviors per provider', () => {
    const claude = getProviderCapabilities('claude');
    const codex = getProviderCapabilities('codex');
    expect(claude.idleStreamEndHandling).toBe('skip');
    expect(codex.idleStreamEndHandling).toBe('minimal');
    expect(claude.stripsDuplicateTrailingToolMessages).toBe(false);
    expect(codex.stripsDuplicateTrailingToolMessages).toBe(true);
    expect(claude.alwaysPreservesShrinkTail).toBe(false);
    expect(codex.alwaysPreservesShrinkTail).toBe(true);
  });

  it('declares runtime provider bridge events', () => {
    expect(getProviderCapabilities('claude').runtimeProviderEvents).toEqual({
      listEvent: 'get_providers',
      switchEvent: 'switch_provider',
    });
    expect(getProviderCapabilities('codex').runtimeProviderEvents).toEqual({
      listEvent: 'get_codex_providers',
      switchEvent: 'switch_codex_provider',
    });
  });

  it('declares icon vendors and process icons', () => {
    expect(getProviderCapabilities('claude').iconVendor).toBe('claude');
    expect(getProviderCapabilities('codex').iconVendor).toBe('openai');
    expect(getProviderCapabilities('claude').processIcon).toBe('codicon-server-process');
    expect(getProviderCapabilities('codex').processIcon).toBe('codicon-comment-discussion');
    expect(getProviderCapabilities('unknown').processIcon).toBe('codicon-debug-disconnect');
  });
});

describe('readProviderCustomModels', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads strictly-validated Codex custom models', () => {
    localStorage.setItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS, JSON.stringify([
      { id: 'gpt-custom', label: 'Custom GPT' },
      { id: 'no-label' },
      { label: 'no-id' },
    ]));
    expect(readProviderCustomModels('codex')).toEqual([
      { id: 'gpt-custom', label: 'Custom GPT', description: undefined },
    ]);
  });

  it('reads leniently-validated Claude custom models (legacy shape)', () => {
    localStorage.setItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS, JSON.stringify([
      { id: 'my-claude', label: 'My Claude' },
      { id: 'no-label' },
      { label: 'no-id' },
    ]));
    expect(readProviderCustomModels('claude')).toEqual([
      { id: 'my-claude', label: 'My Claude', description: undefined },
      { id: 'no-label', label: 'no-label', description: undefined },
    ]);
  });

  it('returns [] for missing or corrupt storage', () => {
    expect(readProviderCustomModels('claude')).toEqual([]);
    localStorage.setItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS, '{not json');
    expect(readProviderCustomModels('claude')).toEqual([]);
    localStorage.setItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS, '{"not":"an array"}');
    expect(readProviderCustomModels('codex')).toEqual([]);
  });
});
