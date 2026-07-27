import { act, renderHook } from '@testing-library/react';
import { useMessageSender } from './useMessageSender';
import type { UseMessageSenderOptions } from './useMessageSender';

describe('useMessageSender - chatMode payload', () => {
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

  it('includes chatMode in the plain message payload when a non-default Claude chat mode is selected', () => {
    const opts = createOptions({ selectedChatMode: 'plan' });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.chatMode).toBe('plan');
  });

  it('includes chatMode in the attachment message payload', () => {
    const opts = createOptions({ selectedChatMode: 'multitask' });

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
    expect(payload.chatMode).toBe('multitask');
  });

  it('omits chatMode when the default agent mode is selected', () => {
    const opts = createOptions({ selectedChatMode: 'agent' });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload).not.toHaveProperty('chatMode');
  });

  it('omits chatMode when no chat mode is set (undefined)', () => {
    const opts = createOptions();

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload).not.toHaveProperty('chatMode');
  });

  it('omits chatMode for the Codex provider (Codex payloads never carry it)', () => {
    const opts = createOptions({
      currentProvider: 'codex',
      selectedModel: 'gpt-5.5',
      // A stale Claude-side selection must never leak into Codex payloads.
      selectedChatMode: 'plan',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload).not.toHaveProperty('chatMode');
  });
});
