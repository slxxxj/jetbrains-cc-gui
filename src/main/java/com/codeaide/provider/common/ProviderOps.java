package com.codeaide.provider.common;

import com.google.gson.JsonObject;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Provider operations contract.
 *
 * <p>Covers the operations the session layer currently routes by provider name:
 * message send/abort, channel lifecycle, history query, context usage, live
 * permission-mode switch and daemon lifecycle. Optional operations are gated
 * behind {@link #capabilities()} — implementations for providers lacking a
 * capability either act as a no-op or return a failed result, and must never
 * be reached when callers honor the capability flags.
 *
 * <p>Implementations: {@code ClaudeProviderOps} (provider/claude) and
 * {@code CodexProviderOps} (provider/codex). Register new providers in
 * {@code SessionProviderRouter}.
 */
public interface ProviderOps {

    /**
     * Provider name used as the registry key (e.g. "claude", "codex").
     */
    String getProviderName();

    /**
     * Capability declaration for this provider.
     */
    ProviderCapabilities capabilities();

    /**
     * Send a message (streaming response reported via the request callback).
     */
    CompletableFuture<SDKResult> sendMessage(ProviderSendRequest request);

    /**
     * Launch a channel (auto-launch on first send).
     */
    JsonObject launchChannel(String channelId, String sessionId, String cwd);

    /**
     * Interrupt the execution running on a channel.
     */
    void interruptChannel(String channelId);

    /**
     * Get session history messages.
     */
    List<JsonObject> getSessionMessages(String sessionId, String cwd);

    /**
     * Get the context-window usage breakdown.
     * Only meaningful when {@link ProviderCapabilities#supportsContextUsage()}.
     */
    CompletableFuture<JsonObject> getContextUsage(String sessionId, String cwd, String model);

    /**
     * Hot-swap the permission mode of a live runtime.
     * Only meaningful when {@link ProviderCapabilities#supportsLivePermissionMode()}.
     */
    CompletableFuture<JsonObject> setPermissionModeLive(String sessionId, String runtimeSessionEpoch, String mode);

    /**
     * Prewarm the persistent daemon runtime for a session.
     * Only meaningful when {@link ProviderCapabilities#supportsDaemon()}.
     */
    void prewarmDaemon(String cwd, String runtimeSessionEpoch, String sessionId);

    /**
     * Reset the persistent daemon runtime for an epoch.
     * Only meaningful when {@link ProviderCapabilities#supportsDaemon()}.
     */
    void resetPersistentRuntime(String runtimeSessionEpoch);

    /**
     * Shut down the persistent daemon.
     * Only meaningful when {@link ProviderCapabilities#supportsDaemon()}.
     */
    void shutdownDaemon();
}
