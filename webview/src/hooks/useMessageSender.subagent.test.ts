import { act, renderHook } from '@testing-library/react';
import { useMessageSender } from './useMessageSender';
import type { UseMessageSenderOptions } from './useMessageSender';

describe('useMessageSender - subagent model payload', () => {
  const t = ((key: string, opts?: any) => opts?.defaultValue ?? key) as any;

  const createOptions = (overrides: Partial<UseMessageSenderOptions> = {}): UseMessageSenderOptions => ({
    t,
    addToast: vi.fn(),
    currentProvider: 'claude',
    selectedModel: 'claude-opus-4-8',
    permissionMode: 'default',
    reasoningEffort: 'high',
    codexFastMode: 'normal',
    selectedAgent: null,
    sdkStatusLoaded: true,
    currentSdkInstalled: true,
    sentAttachmentsRef: { current: new Map() },
    chatInputRef: { current: null },
    messagesContainerRef: { current: null },
    isUserAtBottomRef: { current: true },
    userPausedRef: { current: false },
    isStreamingRef: { current: false },
    setMessages: vi.fn(),
    setLoading: vi.fn(),
    setLoadingStartTime: vi.fn(),
    setStreamingActive: vi.fn(),
    setSettingsInitialTab: vi.fn(),
    setCurrentView: vi.fn(),
    forceCreateNewSession: vi.fn(),
    handleModeSelect: vi.fn(),
    longContextEnabled: false,
    openContextUsageDialog: vi.fn(),
    closeContextUsageDialog: vi.fn().mockReturnValue(true),
    ...overrides,
  });

  const getBridgePayload = (eventName: string) => {
    const calls = (window.sendToJava as any).mock.calls.map((call: [string]) => call[0]);
    const sendCall = calls
      .map((call: string) => JSON.parse(call) as { type: string; payload?: unknown })
      .find((envelope: { type: string; payload?: unknown }) => envelope.type === eventName);
    expect(sendCall).toBeTruthy();
    const payload = sendCall!.payload;
    return typeof payload === 'string' ? JSON.parse(payload) : payload;
  };

  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('includes subagentModel in the plain message payload when a Claude subagent model is selected', () => {
    const opts = createOptions({ selectedSubagentModel: 'claude-haiku-4-5' });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.subagentModel).toBe('claude-haiku-4-5');
  });

  it('includes subagentModel in the attachment message payload', () => {
    const opts = createOptions({ selectedSubagentModel: 'claude-haiku-4-5' });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello', [{
        id: 'att-1',
        fileName: 'note.txt',
        mediaType: 'text/plain',
        data: 'aGVsbG8=',
      }]);
    });

    const payload = getBridgePayload('send_message_with_attachments');
    expect(payload.subagentModel).toBe('claude-haiku-4-5');
  });

  it('omits subagentModel when no subagent model is selected (default follows main model)', () => {
    const opts = createOptions({ selectedSubagentModel: '' });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload).not.toHaveProperty('subagentModel');
  });

  it('omits subagentModel for the Codex provider (no subagent concept)', () => {
    const opts = createOptions({
      currentProvider: 'codex',
      selectedModel: 'gpt-5.5',
      // A stale Claude-side selection must never leak into Codex payloads.
      selectedSubagentModel: 'claude-haiku-4-5',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload).not.toHaveProperty('subagentModel');
  });
});
