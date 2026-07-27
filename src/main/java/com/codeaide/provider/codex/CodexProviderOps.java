package com.codeaide.provider.codex;

import com.codeaide.provider.common.ProviderCapabilities;
import com.codeaide.provider.common.ProviderOps;
import com.codeaide.provider.common.ProviderSendRequest;
import com.codeaide.provider.common.SDKResult;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Codex provider operations — adapts {@link CodexSDKBridge} to the
 * provider-agnostic {@link ProviderOps} contract. Pure delegation; all
 * behavior stays in the bridge. Capabilities Codex lacks (daemon runtime,
 * live permission-mode switch, rewind, context usage) are declared false and
 * their operations are no-ops or failed results.
 */
public class CodexProviderOps implements ProviderOps {

    private static final ProviderCapabilities CAPABILITIES = new ProviderCapabilities(
            false,  // daemon — Codex runs per-process, no persistent runtime
            false,  // live permission-mode — Codex rebuilds thread options per turn
            false,  // rewind
            false,  // context usage
            true    // service tier
    );

    private final CodexSDKBridge bridge;

    public CodexProviderOps(CodexSDKBridge bridge) {
        this.bridge = bridge;
    }

    @Override
    public String getProviderName() {
        return "codex";
    }

    @Override
    public ProviderCapabilities capabilities() {
        return CAPABILITIES;
    }

    @Override
    public CompletableFuture<SDKResult> sendMessage(ProviderSendRequest request) {
        // Codex uses threadId (carried in sessionId) and has no daemon epoch,
        // editor-context injection or streaming/thinking toggles.
        return bridge.sendMessage(
                request.channelId,
                request.message,
                request.sessionId,
                request.cwd,
                request.attachments,
                request.permissionMode,
                request.model,
                request.agentPrompt,
                request.reasoningEffort,
                request.serviceTier,
                request.callback
        );
    }

    @Override
    public JsonObject launchChannel(String channelId, String sessionId, String cwd) {
        return bridge.launchChannel(channelId, sessionId, cwd);
    }

    @Override
    public void interruptChannel(String channelId) {
        bridge.interruptChannel(channelId);
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        return bridge.getSessionMessages(sessionId, cwd);
    }

    @Override
    public CompletableFuture<JsonObject> getContextUsage(String sessionId, String cwd, String model) {
        JsonObject result = new JsonObject();
        result.addProperty("success", false);
        result.addProperty("error", "getContextUsage is not supported by the codex provider");
        return CompletableFuture.completedFuture(result);
    }

    @Override
    public CompletableFuture<JsonObject> setPermissionModeLive(String sessionId, String runtimeSessionEpoch, String mode) {
        // No live runtime to hot-swap; the next send rebuilds thread options
        // with the session's current mode.
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public void prewarmDaemon(String cwd, String runtimeSessionEpoch, String sessionId) {
        // No daemon to prewarm.
    }

    @Override
    public void resetPersistentRuntime(String runtimeSessionEpoch) {
        // No persistent runtime to reset.
    }

    @Override
    public void shutdownDaemon() {
        // No daemon to shut down.
    }
}
