import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAvailableModelsEntry,
  installAvailableModelsDispatcher,
  mergeModelLists,
  parseAvailableModelsPayload,
  requestAvailableModels,
  subscribeAvailableModels,
} from './availableModelsStore';
import type { ModelInfo } from '../components/ChatInputBox/types';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('./bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

describe('parseAvailableModelsPayload', () => {
  it('parses a valid dynamic payload', () => {
    const parsed = parseAvailableModelsPayload(JSON.stringify({
      provider: 'claude',
      models: [{ id: 'claude-new-1', label: 'New 1', description: 'desc' }],
      source: 'dynamic',
    }));
    expect(parsed).toEqual({
      provider: 'claude',
      entry: {
        models: [{ id: 'claude-new-1', label: 'New 1', description: 'desc' }],
        source: 'dynamic',
      },
    });
  });

  it('rejects malformed JSON, unknown providers and non-object payloads', () => {
    expect(parseAvailableModelsPayload('not json')).toBeNull();
    expect(parseAvailableModelsPayload(JSON.stringify({ provider: 'gpt', models: [] }))).toBeNull();
    expect(parseAvailableModelsPayload(JSON.stringify('claude'))).toBeNull();
    expect(parseAvailableModelsPayload(JSON.stringify({ models: [] }))).toBeNull();
  });

  it('drops models without a usable id and falls back to id for the label', () => {
    const parsed = parseAvailableModelsPayload(JSON.stringify({
      provider: 'codex',
      models: [
        { id: 'gpt-x' },
        { id: '   ' },
        { label: 'no id' },
        { id: 'gpt-y', label: '  ', description: 42 },
      ],
      source: 'something-else',
    }));
    expect(parsed).toEqual({
      provider: 'codex',
      entry: {
        models: [
          { id: 'gpt-x', label: 'gpt-x', description: undefined },
          { id: 'gpt-y', label: 'gpt-y', description: undefined },
        ],
        source: 'fallback',
      },
    });
  });
});

describe('availableModelsStore dispatcher', () => {
  beforeEach(() => {
    installAvailableModelsDispatcher();
  });

  it('caches payloads per provider and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAvailableModels(listener);

    window.updateAvailableModels?.(JSON.stringify({
      provider: 'claude',
      models: [{ id: 'claude-a', label: 'A' }],
      source: 'dynamic',
    }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getAvailableModelsEntry('claude')).toEqual({
      models: [{ id: 'claude-a', label: 'A' }],
      source: 'dynamic',
    });
    expect(getAvailableModelsEntry('codex')).toBeUndefined();

    window.updateAvailableModels?.(JSON.stringify({
      provider: 'codex',
      models: [{ id: 'gpt-a', label: 'GA' }],
      source: 'fallback',
    }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getAvailableModelsEntry('codex')?.source).toBe('fallback');

    unsubscribe();
    window.updateAvailableModels?.(JSON.stringify({ provider: 'claude', models: [], source: 'fallback' }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores malformed payloads without touching the cache', () => {
    window.updateAvailableModels?.(JSON.stringify({
      provider: 'claude',
      models: [{ id: 'claude-a', label: 'A' }],
      source: 'dynamic',
    }));
    const before = getAvailableModelsEntry('claude');
    window.updateAvailableModels?.('{broken');
    window.updateAvailableModels?.(JSON.stringify({ provider: 'unknown', models: [] }));
    expect(getAvailableModelsEntry('claude')).toEqual(before);
  });
});

describe('requestAvailableModels', () => {
  beforeEach(() => {
    sendBridgeEventMock.mockClear();
    sendBridgeEventMock.mockReturnValue(true);
  });

  it('sends get_available_models with the provider only by default', () => {
    expect(requestAvailableModels('claude')).toBe(true);
    expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'get_available_models',
      JSON.stringify({ provider: 'claude' }),
    );
  });

  it('includes refresh:true when refreshing', () => {
    requestAvailableModels('codex', true);
    expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'get_available_models',
      JSON.stringify({ provider: 'codex', refresh: true }),
    );
  });
});

describe('mergeModelLists', () => {
  const model = (id: string, label = id): ModelInfo => ({ id, label });

  it('merges layers in priority order and de-duplicates by id', () => {
    const merged = mergeModelLists(
      [model('custom-1'), model('shared')],
      [model('dyn-1', 'Dyn'), model('shared', 'DynShared')],
      [model('builtin-1'), model('custom-1', 'BuiltinCustom')],
    );
    expect(merged.map((m) => m.id)).toEqual(['custom-1', 'shared', 'dyn-1', 'builtin-1']);
    expect(merged.find((m) => m.id === 'shared')?.label).toBe('shared');
  });

  it('tolerates undefined and empty layers', () => {
    expect(mergeModelLists(undefined, [model('a')])).toEqual([{ id: 'a', label: 'a' }]);
    expect(mergeModelLists(undefined, undefined)).toEqual([]);
  });
});
