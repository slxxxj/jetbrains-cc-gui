import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAvailableModels } from './useAvailableModels';
import { installAvailableModelsDispatcher, resetAvailableModelsForTests } from '../utils/availableModelsStore';
import type { ProviderKind } from '../utils/providerCapabilities';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

const pushAvailableModels = (payload: unknown) => {
  act(() => {
    window.updateAvailableModels?.(JSON.stringify(payload));
  });
};

describe('useAvailableModels', () => {
  beforeEach(() => {
    resetAvailableModelsForTests();
    installAvailableModelsDispatcher();
    sendBridgeEventMock.mockClear();
    sendBridgeEventMock.mockReturnValue(true);
  });

  it('requests the model list on mount with the provider payload', () => {
    renderHook(() => useAvailableModels('claude'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'get_available_models',
      JSON.stringify({ provider: 'claude' }),
    );
  });

  it('requests again when the provider changes', () => {
    const { rerender } = renderHook(({ provider }) => useAvailableModels(provider), {
      initialProps: { provider: 'claude' as ProviderKind },
    });
    sendBridgeEventMock.mockClear();

    rerender({ provider: 'codex' as ProviderKind });
    expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'get_available_models',
      JSON.stringify({ provider: 'codex' }),
    );
  });

  it('retries the initial request until the bridge is ready', () => {
    vi.useFakeTimers();
    try {
      sendBridgeEventMock.mockReturnValue(false);
      renderHook(() => useAvailableModels('claude'));
      expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);

      sendBridgeEventMock.mockReturnValue(true);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(sendBridgeEventMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes the cached dynamic list after updateAvailableModels fires', () => {
    const { result } = renderHook(() => useAvailableModels('claude'));
    expect(result.current.models).toBeUndefined();

    pushAvailableModels({
      provider: 'claude',
      models: [{ id: 'claude-new', label: 'Claude New' }],
      source: 'dynamic',
    });

    expect(result.current.models).toEqual([{ id: 'claude-new', label: 'Claude New' }]);
    expect(result.current.source).toBe('dynamic');
  });

  it('ignores payloads for the other provider', () => {
    const { result } = renderHook(() => useAvailableModels('claude'));
    pushAvailableModels({
      provider: 'codex',
      models: [{ id: 'gpt-new', label: 'GPT New' }],
      source: 'dynamic',
    });
    expect(result.current.models).toBeUndefined();
  });

  it('refresh sends refresh:true for the current provider', () => {
    const { result } = renderHook(() => useAvailableModels('codex'));
    sendBridgeEventMock.mockClear();

    act(() => {
      result.current.refresh();
    });
    expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'get_available_models',
      JSON.stringify({ provider: 'codex', refresh: true }),
    );
  });
});
