package com.codeaide.session;

import com.codeaide.i18n.CodeAideBundle;
import com.codeaide.settings.CodeaideSettingsService;
import com.codeaide.notifications.ClaudeNotifier;
import com.codeaide.provider.common.ProviderOps;
import com.codeaide.provider.common.ProviderSendRequest;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Owns message-send orchestration while ClaudeSession remains the public session facade.
 */
public class SessionSendService {

    private static final Logger LOG = Logger.getInstance(SessionSendService.class);
    public static final String CODEX_FAST_SERVICE_TIER = "fast";

    private final Project project;
    private final SessionState state;
    private final SessionCallbackFacade callbackFacade;
    private final MessageParser messageParser;
    private final MessageMerger messageMerger;
    private final Gson gson;
    private final SessionProviderRouter providerRouter;
    private final SessionContextService contextService;

    public SessionSendService(
            Project project,
            SessionState state,
            SessionCallbackFacade callbackFacade,
            MessageParser messageParser,
            MessageMerger messageMerger,
            Gson gson,
            SessionProviderRouter providerRouter,
            SessionContextService contextService
    ) {
        this.project = project;
        this.state = state;
        this.callbackFacade = callbackFacade;
        this.messageParser = messageParser;
        this.messageMerger = messageMerger;
        this.gson = gson;
        this.providerRouter = providerRouter;
        this.contextService = contextService;
    }

    public void prepareContextCollector(EditorContextCollector contextCollector) {
        contextCollector.setPsiContextEnabled(state.isPsiContextEnabled());
        contextCollector.setAutoOpenFileEnabled(readAutoOpenFileEnabled());
    }

    public void updateSessionStateForSend(ClaudeSession.Message userMessage, String normalizedInput) {
        state.addMessage(userMessage);
        callbackFacade.notifyMessageUpdate(state.getMessages());

        if (state.getSummary() == null) {
            String baseSummary = (userMessage.content != null && !userMessage.content.isEmpty())
                    ? userMessage.content
                    : normalizedInput;
            String newSummary = baseSummary.length() > 45 ? baseSummary.substring(0, 45) + "..." : baseSummary;
            state.setSummary(newSummary);
            callbackFacade.notifySummaryReceived(newSummary);
        }

        state.updateLastModifiedTime();
        state.setError(null);
        state.setBusy(true);
        state.setLoading(true);
        ClaudeNotifier.setWaiting(project);
        callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    public CompletableFuture<Void> sendMessageToProvider(
            String channelId,
            String input,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFilesJson,
            String externalAgentPrompt,
            List<String> fileTagPaths,
            String requestedPermissionMode,
            String requestedReasoningEffort,
            String requestedCodexFastMode,
            String requestedSubagentModel
    ) {
        String agentPrompt = externalAgentPrompt;
        if (agentPrompt == null) {
            agentPrompt = getAgentPrompt();
            LOG.info("[Agent] Using agent from global setting (fallback)");
        } else {
            LOG.info("[Agent] Using agent from message (per-tab selection)");
        }

        String currentProvider = state.getProvider();
        String sessionModeBeforeSend = state.getPermissionMode();
        String normalizedRequestedMode = normalizeRequestedPermissionMode(requestedPermissionMode);
        String effectivePermissionMode = resolveEffectivePermissionMode(
                currentProvider,
                normalizedRequestedMode,
                sessionModeBeforeSend
        );

        LOG.info(
                "[ModeSync][Backend] provider=" + currentProvider
                        + ", requested=" + (normalizedRequestedMode != null ? normalizedRequestedMode : "(none)")
                        + ", session=" + (sessionModeBeforeSend != null ? sessionModeBeforeSend : "(none)")
                        + ", effective=" + effectivePermissionMode
        );

        String normalizedRequestedEffort = normalizeRequestedReasoningEffort(requestedReasoningEffort);
        String normalizedRequestedSubagentModel = normalizeRequestedSubagentModel(requestedSubagentModel);

        ProviderOps ops = providerRouter.ops(currentProvider);

        if (ops.capabilities().supportsServiceTier()) {
            String effectiveCodexServiceTier = resolveEffectiveCodexServiceTier(
                    requestedCodexFastMode,
                    state.getCodexServiceTier()
            );
            return sendToCodex(
                    ops,
                    channelId,
                    input,
                    attachments,
                    openedFilesJson,
                    agentPrompt,
                    fileTagPaths,
                    effectivePermissionMode,
                    normalizedRequestedEffort,
                    effectiveCodexServiceTier
            );
        }

        return sendToClaude(ops, channelId, input, attachments, openedFilesJson, agentPrompt,
                effectivePermissionMode, normalizedRequestedEffort, normalizedRequestedSubagentModel);
    }

    /**
     * Normalize the webview-selected subagent model. Model ids are not an enum
     * (the dynamic catalog and custom models are open-ended), so any non-blank
     * value is accepted; null/blank means "no override" (follow the main
     * model / CLI default).
     */
    public static String normalizeRequestedSubagentModel(String subagentModel) {
        if (subagentModel == null) {
            return null;
        }
        String trimmed = subagentModel.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    public static String normalizeRequestedReasoningEffort(String effort) {
        if (effort == null) {
            return null;
        }
        String trimmed = effort.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if (SessionState.isValidReasoningEffort(trimmed)) {
            return trimmed;
        }
        LOG.warn("[ReasoningEffort][Backend] Invalid requested reasoningEffort ignored: " + effort);
        return null;
    }

    public static String normalizeRequestedPermissionMode(String mode) {
        if (mode == null) {
            return null;
        }
        String trimmed = mode.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if (SessionState.isValidPermissionMode(trimmed)) {
            return trimmed;
        }
        LOG.warn("[ModeSync][Backend] Invalid requested permissionMode ignored: " + mode);
        return null;
    }

    public static String resolveEffectivePermissionMode(String provider, String requestedMode, String sessionMode) {
        String resolvedMode = requestedMode;
        if (resolvedMode == null) {
            resolvedMode = normalizeRequestedPermissionMode(sessionMode);
        }
        if (resolvedMode == null) {
            resolvedMode = "default";
        }

        if ("codex".equals(provider) && "plan".equals(resolvedMode)) {
            return "default";
        }
        return resolvedMode;
    }

    public static String getCodexRuntimeAccessError(String accessMode) {
        if (CodeaideSettingsService.CODEX_RUNTIME_ACCESS_MANAGED.equals(accessMode)
                || CodeaideSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN.equals(accessMode)) {
            return null;
        }
        return CodeAideBundle.message("error.codexLocalAccessNotAuthorized");
    }

    public static String normalizeRequestedCodexServiceTier(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if ("fast".equalsIgnoreCase(trimmed) || "priority".equalsIgnoreCase(trimmed)) {
            return CODEX_FAST_SERVICE_TIER;
        }
        if ("normal".equalsIgnoreCase(trimmed)
                || "standard".equalsIgnoreCase(trimmed)
                || "default".equalsIgnoreCase(trimmed)
                || "none".equalsIgnoreCase(trimmed)) {
            return null;
        }
        LOG.warn("[Codex] Invalid fast mode/service tier ignored: " + value);
        return null;
    }

    public static String resolveEffectiveCodexServiceTier(String requestedValue, String sessionValue) {
        String requested = normalizeRequestedCodexServiceTier(requestedValue);
        if (requested != null) {
            return requested;
        }
        if (isExplicitCodexStandardMode(requestedValue)) {
            return null;
        }

        String session = normalizeRequestedCodexServiceTier(sessionValue);
        return session;
    }

    public static boolean isExplicitCodexStandardMode(String value) {
        if (value == null) {
            return false;
        }
        String trimmed = value.trim();
        return "normal".equalsIgnoreCase(trimmed)
                || "standard".equalsIgnoreCase(trimmed)
                || "default".equalsIgnoreCase(trimmed)
                || "none".equalsIgnoreCase(trimmed);
    }

    private CompletableFuture<Void> sendToCodex(
            ProviderOps ops,
            String channelId,
            String input,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFilesJson,
            String agentPrompt,
            List<String> fileTagPaths,
            String effectivePermissionMode,
            String requestedReasoningEffort,
            String effectiveCodexServiceTier
    ) {
        CodexMessageHandler handler = new CodexMessageHandler(state, callbackFacade.getCallbackHandler());
        String accessMode = CodeaideSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE;
        try {
            accessMode = new CodeaideSettingsService().getCodexRuntimeAccessMode();
        } catch (Exception e) {
            LOG.warn("[Codex] Failed to resolve runtime access mode: " + e.getMessage());
        }

        String accessError = getCodexRuntimeAccessError(accessMode);
        if (accessError != null) {
            handler.onError(accessError);
            return CompletableFuture.completedFuture(null);
        }

        String contextAppend = contextService.buildCodexContextAppend(openedFilesJson, fileTagPaths);
        String finalInput = (input != null ? input : "") + contextAppend;

        ProviderSendRequest request = new ProviderSendRequest();
        request.channelId = channelId;
        request.message = finalInput;
        request.sessionId = state.getSessionId();
        request.cwd = state.getCwd();
        request.attachments = attachments;
        request.permissionMode = effectivePermissionMode;
        request.model = state.getModel();
        request.agentPrompt = agentPrompt;
        request.reasoningEffort = requestedReasoningEffort != null ? requestedReasoningEffort : state.getReasoningEffort();
        request.serviceTier = effectiveCodexServiceTier;
        request.callback = handler;

        return ops.sendMessage(request).thenApply(result -> null);
    }

    private CompletableFuture<Void> sendToClaude(
            ProviderOps ops,
            String channelId,
            String input,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFilesJson,
            String agentPrompt,
            String effectivePermissionMode,
            String requestedReasoningEffort,
            String requestedSubagentModel
    ) {
        ClaudeMessageHandler handler = new ClaudeMessageHandler(
                project,
                state,
                callbackFacade.getCallbackHandler(),
                messageParser,
                messageMerger,
                gson
        );

        Boolean streaming = readStreamingEnabled();
        final String runtimeSessionEpoch = state.getRuntimeSessionEpoch();
        final String currentModel = state.getModel();
        LOG.info("[Lifecycle] sendToClaude sessionId=" + (state.getSessionId() != null ? state.getSessionId() : "(new)")
                + ", epoch=" + runtimeSessionEpoch
                + ", cwd=" + state.getCwd()
                + ", model=" + currentModel);

        ProviderSendRequest request = new ProviderSendRequest();
        request.channelId = channelId;
        request.message = input;
        request.sessionId = state.getSessionId();
        request.runtimeSessionEpoch = runtimeSessionEpoch;
        request.cwd = state.getCwd();
        request.attachments = attachments;
        request.permissionMode = effectivePermissionMode;
        request.model = currentModel;
        request.openedFiles = openedFilesJson;
        request.agentPrompt = agentPrompt;
        request.streaming = streaming;
        request.disableThinking = false;
        request.reasoningEffort = requestedReasoningEffort != null ? requestedReasoningEffort : state.getReasoningEffort();
        request.subagentModel = requestedSubagentModel;
        request.callback = handler;

        return ops.sendMessage(request).thenApply(result -> null);
    }

    private boolean readAutoOpenFileEnabled() {
        try {
            String projectPath = project.getBasePath();
            if (projectPath != null) {
                CodeaideSettingsService settingsService = new CodeaideSettingsService();
                boolean autoOpenFileEnabled = settingsService.getAutoOpenFileEnabled(projectPath);
                LOG.info("[EditorContext] Auto open file enabled: " + autoOpenFileEnabled);
                return autoOpenFileEnabled;
            }
        } catch (Exception e) {
            LOG.warn("[EditorContext] Failed to read autoOpenFileEnabled setting: " + e.getMessage());
        }
        return false;
    }

    private Boolean readStreamingEnabled() {
        Boolean streaming = null;
        try {
            String projectPath = project.getBasePath();
            if (projectPath != null) {
                CodeaideSettingsService settingsService = new CodeaideSettingsService();
                streaming = settingsService.getStreamingEnabled(projectPath);
                LOG.info("[Streaming] Read streaming config: " + streaming);
            }
        } catch (Exception e) {
            LOG.warn("[Streaming] Failed to read streaming config: " + e.getMessage());
        }
        return streaming;
    }

    private String getAgentPrompt() {
        try {
            CodeaideSettingsService settingsService = new CodeaideSettingsService();
            String selectedAgentId = settingsService.getSelectedAgentId();
            LOG.info("[Agent] Checking selected agent ID: " + (selectedAgentId != null ? selectedAgentId : "null"));

            if (selectedAgentId != null && !selectedAgentId.isEmpty()) {
                JsonObject agent = settingsService.getAgent(selectedAgentId);
                if (agent != null && agent.has("prompt") && !agent.get("prompt").isJsonNull()) {
                    String agentPrompt = agent.get("prompt").getAsString();
                    String agentName = agent.has("name") ? agent.get("name").getAsString() : "Unknown";
                    LOG.info("[Agent] ✓ Found agent: " + agentName);
                    LOG.info("[Agent] ✓ Prompt length: " + agentPrompt.length() + " chars");
                    LOG.info("[Agent] ✓ Prompt preview: "
                            + (agentPrompt.length() > 100 ? agentPrompt.substring(0, 100) + "..." : agentPrompt));
                    return agentPrompt;
                }
                LOG.info("[Agent] ✗ Agent found but no prompt configured");
            } else {
                LOG.info("[Agent] ✗ No agent selected");
            }
        } catch (Exception e) {
            LOG.warn("[Agent] ✗ Failed to get agent prompt: " + e.getMessage());
        }
        return null;
    }
}
