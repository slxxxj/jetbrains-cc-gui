package com.codeaide.provider.common;

import com.codeaide.session.ClaudeSession;
import com.google.gson.JsonObject;

import java.util.List;

/**
 * Provider-agnostic message send request.
 *
 * <p>Carries the union of the parameters used by the existing provider
 * adapters; each {@link ProviderOps} implementation reads the fields relevant
 * to its provider and ignores the rest. Field documentation states which
 * provider currently consumes it.
 */
public class ProviderSendRequest {

    public String channelId;
    public String message;
    public String sessionId;
    public String cwd;
    public List<ClaudeSession.Attachment> attachments;
    public String permissionMode;
    public String model;
    public String agentPrompt;
    public String reasoningEffort;
    public MessageCallback callback;

    /**
     * Claude-only: runtime session epoch for persistent-runtime cache
     * invalidation. Ignored by providers without daemon support.
     */
    public String runtimeSessionEpoch;

    /**
     * Claude-only: currently open editor files, injected as context.
     */
    public JsonObject openedFiles;

    /**
     * Claude-only: streaming output toggle (null = provider default).
     */
    public Boolean streaming;

    /**
     * Claude-only: disables extended thinking when true.
     */
    public Boolean disableThinking;

    /**
     * Codex-only: service tier selection (null = standard, "fast" = fast tier).
     */
    public String serviceTier;

    /**
     * Claude-only: subagent (Task tool) model override selected in the webview.
     * null/blank = no override (follow the main model / CLI default).
     */
    public String subagentModel;

    /**
     * Claude-only: chat mode selected in the webview (agent/ask/plan/debug/
     * multitask). null/blank = default mode. Values are not validated here;
     * normalization happens in ai-bridge.
     */
    public String chatMode;
}
