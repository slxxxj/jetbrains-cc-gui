package com.codeaide.handler;

import com.codeaide.bridge.NodeDetector;
import com.codeaide.cache.SessionIndexCache;
import com.codeaide.cache.SessionIndexManager;
import com.codeaide.handler.core.BaseMessageHandler;
import com.codeaide.handler.core.HandlerContext;
import com.codeaide.provider.claude.ClaudeSessionTruncateService;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;

/**
 * Recall handler for the message-level 撤回 (recall) feature.
 * Handles the recall_message event from the frontend: restores files to the
 * target message's checkpoint (via the existing rewind pipeline), then
 * truncates the session JSONL so the conversation itself is rolled back.
 * Recalling the first user message deletes the session entirely; the frontend
 * then starts a fresh session.
 */
public class RecallHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(RecallHandler.class);
    private static final Gson gson = new Gson();

    private static final String[] SUPPORTED_TYPES = {
        "recall_message"
    };

    public RecallHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("recall_message".equals(type)) {
            LOG.info("[RecallHandler] Handling: recall_message");
            handleRecall(content);
            return true;
        }
        return false;
    }

    private void handleRecall(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject request = gson.fromJson(content, JsonObject.class);
                String sessionId = optString(request, "sessionId");
                String userMessageId = optString(request, "userMessageId");
                boolean firstMessage = request.has("firstMessage") && request.get("firstMessage").getAsBoolean();

                if (!ClaudeSessionTruncateService.isValidSessionId(sessionId)) {
                    sendResult(false, "Invalid session id");
                    return;
                }
                if (userMessageId == null || userMessageId.isEmpty()) {
                    sendResult(false, "User message id is required");
                    return;
                }

                String projectPath = resolveProjectPath();
                if (projectPath == null) {
                    sendResult(false, "Cannot resolve project path");
                    return;
                }

                if (firstMessage) {
                    handleFirstMessageRecall(sessionId, projectPath);
                } else {
                    handleTruncateRecall(sessionId, userMessageId, projectPath);
                }
            } catch (Exception e) {
                LOG.error("[RecallHandler] Recall failed: " + e.getMessage(), e);
                sendResult(false, "Recall failed: " + e.getMessage());
            }
        });
    }

    /**
     * Recalling the very first user message leaves an empty conversation:
     * delete the session file (and sidechain agent files); the frontend resets
     * the session id and the SDK starts a brand-new session on the next send.
     */
    private void handleFirstMessageRecall(String sessionId, String projectPath) {
        try {
            int deleted = ClaudeSessionTruncateService.deleteSessionWithAgents(projectPath, sessionId);
            cleanupIndexCache(projectPath);

            JsonObject result = new JsonObject();
            result.addProperty("success", true);
            result.addProperty("deletedSession", true);
            result.addProperty("filesDeleted", deleted);
            sendResult(result);
        } catch (Exception e) {
            LOG.error("[RecallHandler] First-message recall failed: " + e.getMessage(), e);
            sendResult(false, "Failed to delete session: " + e.getMessage());
        }
    }

    /**
     * Normal recall: rewind files to the target message's checkpoint first
     * (best-effort — truncation still proceeds when no checkpoint exists),
     * then truncate the JSONL at the target message.
     */
    private void handleTruncateRecall(String sessionId, String userMessageId, String projectPath) {
        Path sessionFile = ClaudeSessionTruncateService.resolveSessionFile(projectPath, sessionId);
        if (sessionFile == null || !Files.exists(sessionFile)) {
            sendResult(false, "Session file not found");
            return;
        }

        String cwd = context.getSession() != null ? context.getSession().getCwd() : null;
        if (cwd == null || cwd.isEmpty()) {
            cwd = projectPath;
        }

        context.getClaudeSDKBridge().rewindFiles(sessionId, userMessageId, cwd)
            .handle((rewindResult, rewindError) -> {
                Integer filesRestored = null;
                String warning = null;
                if (rewindError != null) {
                    warning = "File restore failed: " + rewindError.getMessage();
                    LOG.warn("[RecallHandler] " + warning);
                } else if (rewindResult != null) {
                    boolean rewindOk = rewindResult.has("success") && rewindResult.get("success").getAsBoolean();
                    if (rewindOk) {
                        if (rewindResult.has("filesRestored")) {
                            filesRestored = rewindResult.get("filesRestored").getAsInt();
                        }
                    } else {
                        warning = rewindResult.has("error")
                            ? "File restore failed: " + rewindResult.get("error").getAsString()
                            : "File restore failed";
                        LOG.warn("[RecallHandler] " + warning);
                    }
                }

                try {
                    ClaudeSessionTruncateService.TruncateResult truncate =
                        ClaudeSessionTruncateService.truncateBeforeMessage(sessionFile, userMessageId);
                    cleanupIndexCache(projectPath);

                    JsonObject result = new JsonObject();
                    result.addProperty("success", true);
                    result.addProperty("removedMessages", truncate.removedLines);
                    if (filesRestored != null) {
                        result.addProperty("filesRestored", filesRestored);
                    }
                    if (warning != null) {
                        result.addProperty("warning", warning);
                    }
                    sendResult(result);
                } catch (Exception e) {
                    LOG.error("[RecallHandler] Truncation failed: " + e.getMessage(), e);
                    sendResult(false, "Failed to truncate session: " + e.getMessage());
                }
                return null;
            });
    }

    /** Mirrors HistoryDeleteService cache cleanup so history reloads see the truncated session. */
    private void cleanupIndexCache(String projectPath) {
        try {
            SessionIndexCache.getInstance().clearProject(projectPath);
            SessionIndexManager.getInstance().clearProjectIndex("claude", projectPath);
        } catch (Exception e) {
            LOG.warn("[RecallHandler] Cache cleanup failed (non-fatal): " + e.getMessage());
        }
    }

    /** WSL-aware project path resolution, mirroring HistoryDeleteService. */
    private String resolveProjectPath() {
        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        return NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
    }

    private void sendResult(boolean success, String message) {
        JsonObject result = new JsonObject();
        result.addProperty("success", success);
        result.addProperty("message", message);
        sendResult(result);
    }

    private void sendResult(JsonObject result) {
        String json = gson.toJson(result);
        LOG.info("[RecallHandler] >>> Calling onRecallResult with: " + json);
        ApplicationManager.getApplication().invokeLater(() ->
            callJavaScript("onRecallResult", escapeJs(json)));
    }

    private static String optString(JsonObject obj, String key) {
        return obj.has(key) && !obj.get(key).isJsonNull() ? obj.get(key).getAsString() : null;
    }
}
