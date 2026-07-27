package com.codeaide.handler;

import com.codeaide.handler.core.BaseMessageHandler;
import com.codeaide.handler.core.HandlerContext;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.concurrent.CompletableFuture;

/**
 * Available-models message handler.
 *
 * Serves the webview model selector with the dynamically resolved model catalog:
 * the request is forwarded to the ai-bridge daemon ("<provider>.listModels") and
 * the result is pushed back via window.updateAvailableModels(json). The daemon
 * response is sanitized to the exact contract shape before being forwarded:
 *   {"provider":"claude"|"codex","models":[{"id","label","description"}],
 *    "source":"dynamic"|"fallback"}
 * Every failure path (unknown provider, daemon down, timeout) still produces a
 * response with source:"fallback" so the webview can degrade to its built-in list.
 */
public class AvailableModelsHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(AvailableModelsHandler.class);
    private static final Gson GSON = new Gson();

    private static final String[] SUPPORTED_TYPES = { "get_available_models" };

    public AvailableModelsHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if (!"get_available_models".equals(type)) {
            return false;
        }
        handleGetAvailableModels(content);
        return true;
    }

    private void handleGetAvailableModels(String content) {
        String provider = context.getCurrentProvider();
        boolean refresh = false;
        try {
            if (content != null && !content.isBlank()) {
                JsonObject json = GSON.fromJson(content, JsonObject.class);
                if (json != null) {
                    if (json.has("provider") && !json.get("provider").isJsonNull()) {
                        provider = json.get("provider").getAsString();
                    }
                    if (json.has("refresh") && !json.get("refresh").isJsonNull()) {
                        refresh = json.get("refresh").getAsBoolean();
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("[AvailableModelsHandler] Failed to parse get_available_models content: " + e.getMessage());
        }

        if (!"claude".equals(provider) && !"codex".equals(provider)) {
            LOG.warn("[AvailableModelsHandler] Unknown provider for get_available_models: " + provider);
            pushPayload(buildFallbackPayload(provider, "unknown provider"));
            return;
        }

        final String requestedProvider = provider;
        final boolean requestedRefresh = refresh;
        // The daemon query can block on a cold daemon start (up to ~30s); keep
        // the JCEF message thread free for heartbeats and other messages.
        CompletableFuture.runAsync(() -> {
            context.getClaudeSDKBridge().listAvailableModels(requestedProvider, requestedRefresh)
                    .thenAccept(payload -> pushPayload(sanitizePayload(requestedProvider, payload)))
                    .exceptionally(ex -> {
                        // listAvailableModels never completes exceptionally by design;
                        // keep the contract anyway if that ever changes.
                        LOG.warn("[AvailableModelsHandler] listAvailableModels failed: " + ex.getMessage());
                        pushPayload(buildFallbackPayload(requestedProvider, ex.getMessage()));
                        return null;
                    });
        }, AppExecutorUtil.getAppExecutorService());
    }

    /**
     * Enforce the contract shape on the daemon payload: provider echoes the
     * request, models defaults to an empty array, unknown/missing source or an
     * empty dynamic list degrades to "fallback".
     */
    static JsonObject sanitizePayload(String requestedProvider, JsonObject payload) {
        JsonObject result = payload != null ? payload : new JsonObject();
        result.addProperty("provider", requestedProvider);
        if (!result.has("models") || !result.get("models").isJsonArray()) {
            result.add("models", new JsonArray());
        }
        String source = result.has("source") && !result.get("source").isJsonNull()
                ? result.get("source").getAsString() : "";
        if (!"dynamic".equals(source) || result.getAsJsonArray("models").size() == 0) {
            result.addProperty("source", "fallback");
        }
        return result;
    }

    static JsonObject buildFallbackPayload(String provider, String error) {
        JsonObject payload = new JsonObject();
        payload.addProperty("provider", provider);
        payload.add("models", new JsonArray());
        payload.addProperty("source", "fallback");
        if (error != null && !error.isEmpty()) {
            payload.addProperty("error", error);
        }
        return payload;
    }

    private void pushPayload(JsonObject payload) {
        String json = GSON.toJson(payload);
        ApplicationManager.getApplication().invokeLater(() ->
                callJavaScript("window.updateAvailableModels", escapeJs(json)));
    }
}
