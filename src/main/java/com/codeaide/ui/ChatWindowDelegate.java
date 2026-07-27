package com.codeaide.ui;

import com.codeaide.i18n.CodeAideBundle;
import com.codeaide.session.ClaudeSession;
import com.codeaide.settings.CodeaideSettingsService;
import com.codeaide.handler.AgentHandler;
import com.codeaide.handler.AvailableModelsHandler;
import com.codeaide.handler.ClipboardHandler;
import com.codeaide.handler.ContextHandler;
import com.codeaide.handler.CodexMcpServerHandler;
import com.codeaide.handler.DependencyHandler;
import com.codeaide.handler.DiffHandler;
import com.codeaide.handler.core.HandlerContext;
import com.codeaide.handler.history.HistoryHandler;
import com.codeaide.handler.McpServerHandler;
import com.codeaide.handler.marketplace.McpMarketplaceHandler;
import com.codeaide.handler.importer.McpServerImportHandler;
import com.codeaide.handler.core.MessageDispatcher;
import com.codeaide.handler.NodeProcessHandler;
import com.codeaide.handler.PermissionHandler;
import com.codeaide.handler.PromptEnhancerHandler;
import com.codeaide.handler.PromptHandler;
import com.codeaide.handler.provider.CustomModelPricingHandler;
import com.codeaide.handler.provider.ProviderHandler;
import com.codeaide.handler.RewindHandler;
import com.codeaide.handler.SessionHandler;
import com.codeaide.handler.SettingsHandler;
import com.codeaide.handler.SkillHandler;
import com.codeaide.handler.TabHandler;
import com.codeaide.handler.WindowEventHandler;
import com.codeaide.handler.file.FileExportHandler;
import com.codeaide.handler.file.FileHandler;
import com.codeaide.handler.file.OpenClassHandler;
import com.codeaide.handler.file.UndoFileHandler;
import com.codeaide.permission.PermissionService;
import com.codeaide.provider.claude.ClaudeSDKBridge;
import com.codeaide.provider.codex.CodexSDKBridge;
import com.codeaide.provider.common.DaemonBridge;
import com.codeaide.provider.common.MessageCallback;
import com.codeaide.provider.common.SDKResult;
import com.codeaide.session.SessionLifecycleManager;
import com.codeaide.session.StreamMessageCoalescer;
import com.codeaide.util.JsUtils;
import com.codeaide.util.MessageJsonConverter;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.ui.content.Content;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.util.concurrency.AppExecutorUtil;

import javax.swing.*;
import java.util.List;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Delegates for initialization setup and runtime operations:
 * handler registration, permission setup, tab status, QuickFix, and frontend ready handling.
 */
public class ChatWindowDelegate {

    private static final Logger LOG = Logger.getInstance(ChatWindowDelegate.class);
    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";
    private static final String PERMISSION_MODE_PROPERTY_KEY = "claude.code.permission.mode";
    private static final int STATUS_RESET_DELAY_SECONDS = 5;

    public enum TabAnswerStatus {
        IDLE,
        ANSWERING,
        COMPLETED
    }

    public interface DelegateHost {
        Project getProject();
        ClaudeSDKBridge getClaudeSDKBridge();
        CodexSDKBridge getCodexSDKBridge();
        ClaudeSession getSession();
        CodeaideSettingsService getSettingsService();
        JPanel getMainPanel();
        JBCefBrowser getBrowser();
        boolean isDisposed();
        void callJavaScript(String fn, String... args);
        Content getParentContent();
        String getOriginalTabName();
        void setOriginalTabName(String name);
        String getSessionId();
        HandlerContext getHandlerContext();
        void setHandlerContext(HandlerContext ctx);
        void setMessageDispatcher(MessageDispatcher d);
        void setPermissionHandler(PermissionHandler h);
        void setHistoryHandler(HistoryHandler h);
        SessionLifecycleManager getSessionLifecycleManager();
        StreamMessageCoalescer getStreamCoalescer();
        WebviewWatchdog getWebviewWatchdog();
        PermissionHandler getPermissionHandler();
        void interruptDueToPermissionDenial();
        boolean isFrontendReady();
        void setFrontendReady(boolean ready);
        void setSlashCommandsFetched(boolean fetched);
        void setFetchedSlashCommandsCount(int count);
        void persistTabSessionState();
    }

    private final DelegateHost host;
    private TabAnswerStatus currentTabStatus = TabAnswerStatus.IDLE;
    private ScheduledFuture<?> statusResetTask;
    private volatile String pendingQuickFixPrompt = null;
    private volatile MessageCallback pendingQuickFixCallback = null;

    public ChatWindowDelegate(DelegateHost host) {
        this.host = host;
    }

    public void loadNodePathFromSettings() {
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        CodexSDKBridge codexSDKBridge = host.getCodexSDKBridge();
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String savedNodePath = props.getValue(NODE_PATH_PROPERTY_KEY);

            if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
                String path = savedNodePath.trim();
                claudeSDKBridge.setNodeExecutable(path);
                codexSDKBridge.setNodeExecutable(path);
                claudeSDKBridge.verifyAndCacheNodePath(path);
                LOG.info("Using manually configured Node.js path: " + path);
            } else {
                LOG.info("No saved Node.js path found, attempting auto-detection...");
                com.codeaide.model.NodeDetectionResult detected =
                    claudeSDKBridge.detectNodeWithDetails();

                if (detected != null && detected.isFound() && detected.getNodePath() != null) {
                    String detectedPath = detected.getNodePath();
                    String detectedVersion = detected.getNodeVersion();

                    props.setValue(NODE_PATH_PROPERTY_KEY, detectedPath);
                    claudeSDKBridge.setNodeExecutable(detectedPath);
                    codexSDKBridge.setNodeExecutable(detectedPath);
                    claudeSDKBridge.verifyAndCacheNodePath(detectedPath);

                    LOG.info("Auto-detected Node.js: " + detectedPath + " (" + detectedVersion + ")");
                } else {
                    LOG.warn("Failed to auto-detect Node.js path. Error: " +
                        (detected != null ? detected.getErrorMessage() : "Unknown error"));
                }
            }
        } catch (Exception e) {
            LOG.error("Failed to load Node.js path: " + e.getMessage(), e);
        }
    }

    public void loadPermissionModeFromSettings() {
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String savedMode = props.getValue(PERMISSION_MODE_PROPERTY_KEY);
            if (savedMode != null && !savedMode.trim().isEmpty()) {
                String mode = savedMode.trim();
                ClaudeSession session = host.getSession();
                if (session != null) {
                    session.setPermissionMode(mode);
                    host.persistTabSessionState();
                    LOG.info("Loaded permission mode from settings: " + mode);
                    com.codeaide.notifications.ClaudeNotifier.setMode(host.getProject(), mode);
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to load permission mode: " + e.getMessage());
        }
    }

    public void savePermissionModeToSettings(String mode) {
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            props.setValue(PERMISSION_MODE_PROPERTY_KEY, mode);
            LOG.info("Saved permission mode to settings: " + mode);
        } catch (Exception e) {
            LOG.warn("Failed to save permission mode: " + e.getMessage());
        }
    }

    public void syncActiveProvider() {
        try {
            // Phase 5c: provider credentials are no longer synced into
            // ~/.claude/settings.json — they live in ~/.codeaide/config.json and
            // the bridge reads them from there. Startup now only runs the
            // one-time legacy migration (import-only, idempotent).
            CodeaideSettingsService settingsService = host.getSettingsService();
            com.codeaide.settings.LegacyCredentialMigration.runIfNeeded(settingsService);
        } catch (Exception e) {
            LOG.warn("Failed to run legacy credential migration on startup: " + e.getMessage());
        }
    }

    public String setupPermissionService() {
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        CodexSDKBridge codexSDKBridge = host.getCodexSDKBridge();
        Project project = host.getProject();
        String sessionId = claudeSDKBridge.getSessionId();

        if ((sessionId == null || sessionId.isEmpty()) && codexSDKBridge != null) {
            sessionId = codexSDKBridge.getSessionId();
        }

        if (sessionId == null || sessionId.isEmpty()) {
            LOG.warn("Failed to get session ID from bridges, generating fallback UUID");
            sessionId = java.util.UUID.randomUUID().toString();
        }

        claudeSDKBridge.setSessionId(sessionId);
        if (codexSDKBridge != null) {
            codexSDKBridge.setSessionId(sessionId);
        }
        LOG.info("Unified bridge sessionId for PermissionService routing: " + sessionId);

        PermissionService permissionService = PermissionService.getInstance(project, sessionId);
        permissionService.start();
        permissionService.registerDialogShower(project, (toolName, inputs) ->
            host.getPermissionHandler().showFrontendPermissionDialog(toolName, inputs));
        permissionService.registerAskUserQuestionDialogShower(project, (requestId, questionsData) ->
            host.getPermissionHandler().showAskUserQuestionDialog(requestId, questionsData));
        permissionService.registerPlanApprovalDialogShower(project, (requestId, planData) ->
            host.getPermissionHandler().showPlanApprovalDialog(requestId, planData));

        // Daemon permission channel: permission prompts from this window's
        // daemon arrive as out-of-band permission_request envelopes and are
        // answered through the daemon's stdin. While the daemon is alive the
        // file watcher is stopped; daemon death or any per-process spawn
        // reactivates it (fallback guarantee).
        claudeSDKBridge.addDaemonEventListener((event, data) -> {
            if ("permission_request".equals(event)) {
                permissionService.handleDaemonPermissionRequest(data, claudeSDKBridge::sendDaemonOutOfBand);
            }
        });
        claudeSDKBridge.addDaemonLifecycleListener(new DaemonBridge.DaemonLifecycleListener() {
            @Override
            public void onDaemonReady() {
                permissionService.setDaemonChannelActive(true);
            }

            @Override
            public void onDaemonDied() {
                permissionService.setDaemonChannelActive(false);
            }
        });
        LOG.info("Started permission service with frontend dialog, AskUserQuestion dialog, and PlanApproval dialog for project: " + project.getName());
        return sessionId;
    }

    public void initializeHandlers() {
        Project project = host.getProject();
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        CodexSDKBridge codexSDKBridge = host.getCodexSDKBridge();
        CodeaideSettingsService settingsService = host.getSettingsService();

        HandlerContext.JsCallback jsCallback = new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
                host.callJavaScript(functionName, args);
            }
            @Override
            public String escapeJs(String str) {
                return JsUtils.escapeJs(str);
            }
        };

        HandlerContext handlerContext = new HandlerContext(project, claudeSDKBridge, codexSDKBridge, settingsService, jsCallback);
        handlerContext.setSession(host.getSession());
        host.setHandlerContext(handlerContext);

        MessageDispatcher messageDispatcher = new MessageDispatcher();
        host.setMessageDispatcher(messageDispatcher);

        messageDispatcher.registerHandler(new ProviderHandler(handlerContext));
        messageDispatcher.registerHandler(new CustomModelPricingHandler(handlerContext, settingsService));
        messageDispatcher.registerHandler(new McpServerHandler(handlerContext));
        messageDispatcher.registerHandler(new McpMarketplaceHandler(handlerContext));
        messageDispatcher.registerHandler(new McpServerImportHandler(handlerContext));
        messageDispatcher.registerHandler(new CodexMcpServerHandler(handlerContext, settingsService.getCodexMcpServerManager()));
        messageDispatcher.registerHandler(new SkillHandler(handlerContext));
        messageDispatcher.registerHandler(new FileHandler(handlerContext));
        messageDispatcher.registerHandler(new SettingsHandler(handlerContext));
        messageDispatcher.registerHandler(new SessionHandler(handlerContext));
        messageDispatcher.registerHandler(new ContextHandler(handlerContext));
        messageDispatcher.registerHandler(new FileExportHandler(handlerContext));
        messageDispatcher.registerHandler(new DiffHandler(handlerContext));
        messageDispatcher.registerHandler(new PromptEnhancerHandler(handlerContext));
        messageDispatcher.registerHandler(new AgentHandler(handlerContext));
        messageDispatcher.registerHandler(new PromptHandler(handlerContext));
        messageDispatcher.registerHandler(new TabHandler(handlerContext));
        messageDispatcher.registerHandler(new RewindHandler(handlerContext));
        messageDispatcher.registerHandler(new UndoFileHandler(handlerContext));
        messageDispatcher.registerHandler(new DependencyHandler(handlerContext));
        messageDispatcher.registerHandler(new ClipboardHandler(handlerContext));
        messageDispatcher.registerHandler(new NodeProcessHandler(handlerContext));
        messageDispatcher.registerHandler(new AvailableModelsHandler(handlerContext));

        messageDispatcher.registerHandler(new WindowEventHandler(handlerContext, new WindowEventHandler.Callback() {
            @Override public void onHeartbeat(String content) { host.getWebviewWatchdog().handleHeartbeat(content); }
            @Override public void onTabLoadingChanged(boolean loading) { updateTabLoadingState(loading); }
            @Override public void onTabStatusChanged(String statusStr) {
                TabAnswerStatus status;
                switch (statusStr) {
                    case "answering":
                        status = TabAnswerStatus.ANSWERING;
                        break;
                    case "completed":
                        status = TabAnswerStatus.COMPLETED;
                        break;
                    default:
                        status = TabAnswerStatus.IDLE;
                        break;
                }
                updateTabStatus(status);
            }
            @Override public void onCreateNewSession() {
                host.getSessionLifecycleManager().createNewSession();
            }
            @Override public void onFrontendReady() { handleFrontendReady(); }
            @Override public void onRefreshSlashCommands() {
                host.getSessionLifecycleManager().fetchSlashCommandsOnStartup();
            }
        }));

        PermissionHandler permissionHandler = new PermissionHandler(handlerContext);
        permissionHandler.setPermissionDeniedCallback(host::interruptDueToPermissionDenial);
        host.setPermissionHandler(permissionHandler);
        messageDispatcher.registerHandler(permissionHandler);

        HistoryHandler historyHandler = new HistoryHandler(handlerContext);
        historyHandler.setSessionLoadCallback((sessionId, projectPath, provider) ->
            host.getSessionLifecycleManager().loadHistorySession(sessionId, projectPath, provider));
        host.setHistoryHandler(historyHandler);
        messageDispatcher.registerHandler(historyHandler);

        LOG.info("Registered " + messageDispatcher.getHandlerCount() + " message handlers");
    }

    public void initializeStatusBar() {
        ApplicationManager.getApplication().invokeLater(() -> {
            Project project = host.getProject();
            if (project == null || host.isDisposed()) { return; }

            ClaudeSession session = host.getSession();
            String mode = session != null ? session.getPermissionMode() : "default";
            com.codeaide.notifications.ClaudeNotifier.setMode(project, mode);

            String model = session != null ? session.getModel() : "claude-sonnet-4-6";
            com.codeaide.notifications.ClaudeNotifier.setModel(project, model);

            try {
                CodeaideSettingsService settingsService = host.getSettingsService();
                String selectedId = settingsService.getSelectedAgentId();
                if (selectedId != null) {
                    JsonObject agent = settingsService.getAgent(selectedId);
                    if (agent != null) {
                        String agentName = agent.has("name") ? agent.get("name").getAsString() : "Agent";
                        com.codeaide.notifications.ClaudeNotifier.setAgent(project, agentName);
                    }
                }
            } catch (Exception e) {
                LOG.warn("Failed to set initial agent in status bar: " + e.getMessage());
            }
        });
    }

    public void updateTabStatus(TabAnswerStatus status) {
        Content parentContent = host.getParentContent();
        String originalTabName = host.getOriginalTabName();
        if (parentContent == null || originalTabName == null) {
            LOG.warn("[TabStatus] Cannot update - parentContent or originalTabName is null");
            return;
        }

        if (status == currentTabStatus) {
            LOG.debug("[TabStatus] Skipping redundant update for tab: " + originalTabName);
            return;
        }

        currentTabStatus = status;

        if (statusResetTask != null && !statusResetTask.isDone()) {
            statusResetTask.cancel(false);
            statusResetTask = null;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            String tabName = originalTabName;
            String currentDisplayName = parentContent.getDisplayName();
            if (currentDisplayName != null && !currentDisplayName.startsWith(tabName)) {
                tabName = currentDisplayName.endsWith("...")
                    ? currentDisplayName.substring(0, currentDisplayName.length() - 3)
                    : currentDisplayName;
                host.setOriginalTabName(tabName);
                LOG.debug("[TabStatus] Detected external rename, updated originalTabName to: " + tabName);
            }

            String displayName;
            switch (status) {
                case ANSWERING:
                    displayName = tabName + "...";
                    LOG.debug("[TabStatus] Set answering state for tab: " + displayName);
                    break;
                case COMPLETED:
                    String completedText = CodeAideBundle.message("tab.status.completed");
                    displayName = tabName + " (" + completedText + ")";
                    LOG.debug("[TabStatus] Set completed state for tab: " + displayName);

                    statusResetTask = AppExecutorUtil.getAppScheduledExecutorService().schedule(() -> {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            updateTabStatus(TabAnswerStatus.IDLE);
                        });
                    }, STATUS_RESET_DELAY_SECONDS, TimeUnit.SECONDS);
                    break;
                case IDLE:
                default:
                    displayName = tabName;
                    LOG.debug("[TabStatus] Restored idle state for tab: " + displayName);
                    break;
            }
            parentContent.setDisplayName(displayName);
        });
    }

    @Deprecated
    public void updateTabLoadingState(boolean loading) {
        updateTabStatus(loading ? TabAnswerStatus.ANSWERING : TabAnswerStatus.IDLE);
    }

    public void sendQuickFixMessage(String prompt, boolean isQuickFix, MessageCallback callback) {
        ClaudeSession session = host.getSession();
        if (session == null) {
            LOG.warn("QuickFix: Session is null, cannot send message");
            ApplicationManager.getApplication().invokeLater(() -> {
                callback.onError("Session not initialized. Please wait for the tool window to fully load.");
            });
            return;
        }

        session.getContextCollector().setQuickFix(isQuickFix);

        if (!host.isFrontendReady()) {
            LOG.info("QuickFix: Frontend not ready, queuing message for later");
            pendingQuickFixPrompt = prompt;
            pendingQuickFixCallback = callback;
            return;
        }

        executeQuickFixInternal(prompt, callback);
    }

    private void executePendingQuickFix(String prompt, MessageCallback callback) {
        ClaudeSession session = host.getSession();
        if (session == null || host.isDisposed()) {
            ApplicationManager.getApplication().invokeLater(() -> {
                callback.onError("Session not available");
            });
            return;
        }
        executeQuickFixInternal(prompt, callback);
    }

    private void executeQuickFixInternal(String prompt, MessageCallback callback) {
        String escapedPrompt = JsUtils.escapeJs(prompt);
        host.callJavaScript("addUserMessage", escapedPrompt);
        host.callJavaScript("showLoading", "true");

        host.getSession().send(prompt, null, (String) null).thenRun(() -> {
            List<ClaudeSession.Message> messages = host.getSession().getMessages();
            if (!messages.isEmpty()) {
                ClaudeSession.Message last = messages.get(messages.size() - 1);
                if (last.type == ClaudeSession.Message.Type.ASSISTANT && last.content != null) {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callback.onComplete(SDKResult.success(last.content));
                    });
                }
            }
        }).exceptionally(ex -> {
            ApplicationManager.getApplication().invokeLater(() -> {
                callback.onError(ex.getMessage());
            });
            return null;
        });
    }

    public void handleFrontendReady() {
        LOG.info("Received frontend_ready signal, frontend is now ready to receive data");
        host.setFrontendReady(true);
        host.getWebviewWatchdog().markFrontendReady();

        host.callJavaScript(
            "window.updateLinkifyCapabilities",
            JsUtils.escapeJs(OpenClassHandler.buildCapabilitiesJson())
        );
        host.getSessionLifecycleManager().sendCurrentPermissionMode();
        replayCurrentSessionStateToFrontend();
        host.persistTabSessionState();

        if (pendingQuickFixPrompt != null && pendingQuickFixCallback != null) {
            LOG.info("Processing pending QuickFix message after frontend ready");
            String prompt = pendingQuickFixPrompt;
            MessageCallback callback = pendingQuickFixCallback;
            pendingQuickFixPrompt = null;
            pendingQuickFixCallback = null;
            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                executePendingQuickFix(prompt, callback);
            });
        }

        host.getStreamCoalescer().flush(null);
    }

    private void replayCurrentSessionStateToFrontend() {
        ClaudeSession session = host.getSession();
        if (session == null || host.isDisposed()) {
            return;
        }

        try {
            String sessionId = session.getSessionId();
            if (sessionId != null && !sessionId.trim().isEmpty()) {
                host.callJavaScript("setSessionId", JsUtils.escapeJs(sessionId));
            }

            List<ClaudeSession.Message> messages = session.getMessages();
            if (!messages.isEmpty()) {
                String messagesJson = MessageJsonConverter.convertMessagesToJson(messages);
                host.callJavaScript("updateMessages", JsUtils.escapeJs(messagesJson));
            }

            host.callJavaScript("showLoading", String.valueOf(session.isLoading()));
            host.callJavaScript("showThinkingStatus", String.valueOf(false));

            String summary = session.getSummary();
            if (summary != null && !summary.trim().isEmpty()) {
                host.callJavaScript("showSummary", JsUtils.escapeJs(summary));
            }

            // FIX: Restore streaming state after webview reload.
            // When the watchdog reloads the webview during active streaming, the frontend's
            // isStreamingRef is reset to false, causing all onContentDelta callbacks to be
            // silently dropped.  Re-sending onStreamStart ensures the frontend accepts
            // subsequent streaming deltas and the stall watchdog is properly initialized.
            boolean streamActive = host.getStreamCoalescer().isStreamActive();
            if (streamActive) {
                LOG.debug("Replaying streaming state to frontend (session was actively streaming during reload)");
                host.callJavaScript("onStreamStart", "replay");
            }

            LOG.info("Replayed current session state to frontend: sessionId="
                    + (sessionId != null ? sessionId : "(none)")
                    + ", messages=" + messages.size()
                    + ", loading=" + session.isLoading()
                    + ", streaming=" + streamActive);
        } catch (Exception e) {
            LOG.warn("Failed to replay current session state to frontend: " + e.getMessage(), e);
        }
    }

    public void dispose() {
        if (statusResetTask != null && !statusResetTask.isDone()) {
            statusResetTask.cancel(false);
            statusResetTask = null;
            LOG.debug("[TabStatus] Cancelled pending status reset task");
        }
    }
}
