import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../types/provider';
import {
  getProviderCustomModels,
  resetProviderCustomModelsForTests,
  setProviderCustomModels,
  subscribeProviderCustomModels,
} from './providerCustomModelsStore';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('./bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

const pushClaudeProviders = (providers: unknown[]) => {
  window.updateProviders?.(JSON.stringify(providers));
};

const pushCodexProviders = (providers: unknown[]) => {
  window.updateCodexProviders?.(JSON.stringify(providers));
};

describe('providerCustomModelsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetProviderCustomModelsForTests();
    sendBridgeEventMock.mockClear();
    sendBridgeEventMock.mockReturnValue(true);
  });

  it('serves legacy localStorage models when no provider entries are known', () => {
    localStorage.setItem(
      STORAGE_KEYS.CODEX_CUSTOM_MODELS,
      JSON.stringify([{ id: 'legacy-codex', label: 'Legacy Codex' }]),
    );
    expect(getProviderCustomModels('codex')).toEqual([{ id: 'legacy-codex', label: 'Legacy Codex' }]);
  });

  it('normalizes legacy Claude entries that lack a label instead of dropping them', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_CUSTOM_MODELS,
      JSON.stringify([{ id: 'no-label-model' }]),
    );
    expect(getProviderCustomModels('claude')).toEqual([{ id: 'no-label-model', label: 'no-label-model' }]);
  });

  it('prefers the active provider entry customModels over the legacy list', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_CUSTOM_MODELS,
      JSON.stringify([{ id: 'legacy', label: 'Legacy' }]),
    );
    getProviderCustomModels('claude'); // bootstrap
    pushClaudeProviders([{
      id: 'p1',
      name: 'P1',
      isActive: true,
      customModels: [{ id: 'entry-model', label: 'Entry Model' }],
    }]);
    expect(getProviderCustomModels('claude')).toEqual([{ id: 'entry-model', label: 'Entry Model' }]);
  });

  it('normalizes entry customModels without a label instead of dropping them', () => {
    getProviderCustomModels('claude'); // bootstrap
    pushClaudeProviders([{
      id: 'p1',
      name: 'P1',
      isActive: true,
      customModels: [{ id: 'label-less-entry' }],
    }]);
    expect(getProviderCustomModels('claude')).toEqual([{ id: 'label-less-entry', label: 'label-less-entry' }]);
  });

  it('migrates legacy localStorage models into the active provider entry once', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_CUSTOM_MODELS,
      JSON.stringify([{ id: 'legacy-1', label: 'Legacy 1' }]),
    );
    getProviderCustomModels('claude'); // bootstrap reads the legacy list
    sendBridgeEventMock.mockClear();

    pushClaudeProviders([{ id: 'p1', name: 'P1', isActive: true }]);

    expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'update_provider',
      JSON.stringify({ id: 'p1', updates: { customModels: [{ id: 'legacy-1', label: 'Legacy 1' }] } }),
    );
    // Optimistic read: the migrated models are visible immediately.
    expect(getProviderCustomModels('claude')).toEqual([{ id: 'legacy-1', label: 'Legacy 1' }]);
    // Legacy data stays until the entry confirms it (read-only compatibility).
    expect(localStorage.getItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS)).not.toBeNull();
  });

  it('clears the legacy key after the entry confirms the migrated models', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_CUSTOM_MODELS,
      JSON.stringify([{ id: 'legacy-1', label: 'Legacy 1' }]),
    );
    getProviderCustomModels('claude');
    pushClaudeProviders([{ id: 'p1', name: 'P1', isActive: true }]);
    expect(localStorage.getItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS)).not.toBeNull();

    // Backend echoes the entry now carrying customModels → confirm & clear.
    pushClaudeProviders([{
      id: 'p1',
      name: 'P1',
      isActive: true,
      customModels: [{ id: 'legacy-1', label: 'Legacy 1' }],
    }]);
    expect(localStorage.getItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS)).toBeNull();
    expect(getProviderCustomModels('claude')).toEqual([{ id: 'legacy-1', label: 'Legacy 1' }]);
  });

  it('does not migrate into special providers and keeps the legacy write path there', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_CUSTOM_MODELS,
      JSON.stringify([{ id: 'legacy-1', label: 'Legacy 1' }]),
    );
    getProviderCustomModels('claude');
    sendBridgeEventMock.mockClear();

    pushClaudeProviders([{ id: '__cli_login__', name: 'CLI', isActive: true }]);
    expect(sendBridgeEventMock).not.toHaveBeenCalledWith('update_provider', expect.anything());

    setProviderCustomModels('claude', [{ id: 'new-1', label: 'New 1' }]);
    expect(sendBridgeEventMock).not.toHaveBeenCalledWith('update_provider', expect.anything());
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS) || '[]'))
      .toEqual([{ id: 'new-1', label: 'New 1' }]);
    expect(getProviderCustomModels('claude')).toEqual([{ id: 'new-1', label: 'New 1' }]);
  });

  it('writes to the active provider entry, updates optimistically and shadows localStorage', () => {
    getProviderCustomModels('claude');
    pushClaudeProviders([{
      id: 'p1',
      name: 'P1',
      isActive: true,
      customModels: [{ id: 'old', label: 'Old' }],
    }]);
    sendBridgeEventMock.mockClear();

    setProviderCustomModels('claude', [
      { id: 'new', label: 'New' },
      { id: 'bad', label: 'Bad', pricing: { inputCostPer1M: -1 } },
    ]);

    expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'update_provider',
      JSON.stringify({ id: 'p1', updates: { customModels: [{ id: 'new', label: 'New' }] } }),
    );
    expect(getProviderCustomModels('claude')).toEqual([{ id: 'new', label: 'New' }]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS) || '[]'))
      .toEqual([{ id: 'new', label: 'New' }]);
  });

  it('uses update_codex_provider for the codex kind', () => {
    getProviderCustomModels('codex');
    pushCodexProviders([{ id: 'c1', name: 'C1', isActive: true }]);
    sendBridgeEventMock.mockClear();

    setProviderCustomModels('codex', [{ id: 'gpt-custom', label: 'GPT Custom' }]);
    expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'update_codex_provider',
      JSON.stringify({ id: 'c1', updates: { customModels: [{ id: 'gpt-custom', label: 'GPT Custom' }] } }),
    );
    expect(getProviderCustomModels('codex')).toEqual([{ id: 'gpt-custom', label: 'GPT Custom' }]);
  });

  it('notifies subscribers on provider list pushes and writes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProviderCustomModels(listener);
    pushClaudeProviders([{
      id: 'p1',
      name: 'P1',
      isActive: true,
      customModels: [{ id: 'entry-model', label: 'Entry Model' }],
    }]);
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    setProviderCustomModels('claude', [{ id: 'other', label: 'Other' }]);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
