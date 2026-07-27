import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelStatePersistence, type UseModelStatePersistenceOptions } from './useModelStatePersistence';
import type { PermissionMode } from '../../components/ChatInputBox/types';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

function makeOptions(overrides: Partial<UseModelStatePersistenceOptions> = {}): UseModelStatePersistenceOptions {
  return {
    setCurrentProvider: vi.fn(),
    setSelectedClaudeModel: vi.fn(),
    setSelectedCodexModel: vi.fn(),
    setClaudePermissionMode: vi.fn(),
    setCodexPermissionMode: vi.fn(),
    setPermissionMode: vi.fn(),
    setLongContextEnabled: vi.fn(),
    setReasoningEffort: vi.fn(),
    setCodexFastMode: vi.fn(),
    setSelectedSubagentModel: vi.fn(),
    setSelectedChatMode: vi.fn(),
    currentProvider: 'claude',
    selectedClaudeModel: 'claude-sonnet-4-5',
    selectedCodexModel: 'gpt-5-codex',
    claudePermissionMode: 'default' as PermissionMode,
    codexPermissionMode: 'default' as PermissionMode,
    longContextEnabled: false,
    reasoningEffort: 'medium',
    codexFastMode: 'normal',
    selectedSubagentModel: '',
    selectedChatMode: 'agent',
    ...overrides,
  };
}

function bridgeEventsFor(name: string): unknown[][] {
  return sendBridgeEventMock.mock.calls.filter((c) => c[0] === name);
}

describe('useModelStatePersistence — boot sync does not clobber the persisted permission mode', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
  });

  it('does NOT send set_mode on boot when localStorage was wiped (reinstall)', () => {
    // Reinstall wipes JCEF localStorage → the hook would fall back to 'default'.
    // Pushing that to Java on boot would clobber the app-level PropertiesComponent
    // value (e.g. bypassPermissions) that survives the reinstall — the reported
    // "reinstall forgets Auto" bug. Java is the source of truth via get_mode.
    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200); // fire the deferred syncToBackend

    expect(bridgeEventsFor('set_mode')).toHaveLength(0);
    // Provider/model/codex-fast are webview-owned and must still sync.
    expect(bridgeEventsFor('set_provider')).toHaveLength(1);
    expect(bridgeEventsFor('set_model')).toHaveLength(1);
    expect(bridgeEventsFor('set_codex_fast_mode')).toHaveLength(1);
  });

  it('does NOT send set_mode on boot even when localStorage carries a non-default mode', () => {
    // Even when the webview snapshot has a valid mode, Java is authoritative on
    // boot (it may hold a newer value); the webview seeds itself from Java via
    // get_mode → onModeReceived, so the boot path must never push the mode down.
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudePermissionMode: 'bypassPermissions',
      permissionMode: 'bypassPermissions',
    }));

    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200);

    expect(bridgeEventsFor('set_mode')).toHaveLength(0);
  });

  it('retries the boot sync until the JCEF bridge is ready, still without set_mode', () => {
    // Bridge not ready yet → the hook retries every 100ms. Mode must never leak
    // into any of the retried sync attempts either.
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    renderHook(() => useModelStatePersistence(makeOptions()));

    vi.advanceTimersByTime(200); // first attempt: bridge missing → schedules retry
    expect(sendBridgeEventMock).not.toHaveBeenCalled();

    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    vi.advanceTimersByTime(100); // retry now succeeds

    expect(bridgeEventsFor('set_provider')).toHaveLength(1);
    expect(bridgeEventsFor('set_mode')).toHaveLength(0);
  });

  it('hydrates the persisted subagent model and saves it back into the snapshot', () => {
    const setSelectedSubagentModel = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeSubagentModel: 'claude-haiku-4-5',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedSubagentModel })));

    // Hydration restores the saved selection verbatim (unknown ids tolerated).
    expect(setSelectedSubagentModel).toHaveBeenCalledWith('claude-haiku-4-5');

    // The save effect snapshots the current value under claudeSubagentModel.
    const saved = JSON.parse(localStorage.getItem('model-selection-state') ?? '{}');
    expect(saved.claudeSubagentModel).toBe('');
  });

  it('saves a changed subagent model selection into the snapshot', () => {
    renderHook(() => useModelStatePersistence(makeOptions({ selectedSubagentModel: 'glm-4.7-flash' })));

    const saved = JSON.parse(localStorage.getItem('model-selection-state') ?? '{}');
    expect(saved.claudeSubagentModel).toBe('glm-4.7-flash');
  });

  it('hydrates a valid persisted chat mode and rejects unrecognized values', () => {
    const setSelectedChatMode = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeChatMode: 'plan',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedChatMode })));

    expect(setSelectedChatMode).toHaveBeenCalledWith('plan');

    setSelectedChatMode.mockClear();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeChatMode: 'not-a-mode',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedChatMode })));

    // Invalid values are ignored; the slice hook's 'agent' default stands.
    expect(setSelectedChatMode).not.toHaveBeenCalled();
  });

  it('saves a changed chat mode selection into the snapshot', () => {
    renderHook(() => useModelStatePersistence(makeOptions({ selectedChatMode: 'debug' })));

    const saved = JSON.parse(localStorage.getItem('model-selection-state') ?? '{}');
    expect(saved.claudeChatMode).toBe('debug');
  });
});
