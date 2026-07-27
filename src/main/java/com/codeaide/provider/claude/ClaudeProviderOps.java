package com.codeaide.provider.claude;

import com.codeaide.provider.common.ProviderCapabilities;
import com.codeaide.provider.common.ProviderOps;
import com.codeaide.provider.common.ProviderSendRequest;
import com.codeaide.provider.common.SDKResult;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Claude provider operations — adapts {@link ClaudeSDKBridge} to the
 * provider-agnostic {@link ProviderOps} contract. Pure delegation; all
 * behavior stays in the bridge.
 */
public class ClaudeProviderOps implements ProviderOps {

    private static final ProviderCapabilities CAPABILITIES = new ProviderCapabilities(
            true,   // daemon (persistent runtime)
            true,   // live permission-mode hot-swap
            true,   // rewind
            true,   // context usage
            false   // service tier
    );

    private final ClaudeSDKBridge bridge;

    public ClaudeProviderOps(ClaudeSDKBridge bridge) {
        this.bridge = bridge;
    }

    @Override
    public String getProviderName() {
        return "claude";
    }

    @Override
    public ProviderCapabilities capabilities() {
        return CAPABILITIES;
    }

    @Override
    public CompletableFuture<SDKResult> sendMessage(ProviderSendRequest request) {
        return bridge.sendMessage(
                request.channelId,
                request.message,
                request.sessionId,
                request.runtimeSessionEpoch,
                request.cwd,
                request.attachments,
                request.permissionMode,
                request.model,
                request.openedFiles,
                request.agentPrompt,
                request.streaming,
                request.disableThinking,
                request.reasoningEffort,
                request.subagentModel,
                request.chatMode,
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
        return bridge.getContextUsage(sessionId, cwd, model);
    }

    @Override
    public CompletableFuture<JsonObject> setPermissionModeLive(String sessionId, String runtimeSessionEpoch, String mode) {
        return bridge.setPermissionModeLive(sessionId, runtimeSessionEpoch, mode);
    }

    @Override
    public void prewarmDaemon(String cwd, String runtimeSessionEpoch, String sessionId) {
        bridge.prewarmDaemonAsync(cwd, runtimeSessionEpoch, sessionId);
    }

    @Override
    public void resetPersistentRuntime(String runtimeSessionEpoch) {
        bridge.resetPersistentRuntime(runtimeSessionEpoch);
    }

    @Override
    public void shutdownDaemon() {
        bridge.shutdownDaemon();
    }
}
