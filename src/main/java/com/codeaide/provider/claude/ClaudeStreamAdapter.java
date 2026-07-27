package com.codeaide.provider.claude;

import com.codeaide.provider.common.MessageCallback;
import com.codeaide.provider.common.SDKResult;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Adapts tagged Node.js output lines into bridge callbacks and SDKResult updates.
 */
class ClaudeStreamAdapter {

    private final Gson gson;

    ClaudeStreamAdapter(Gson gson) {
        this.gson = gson;
    }

    void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError
    ) {
        processOutputLine(line, callback, result, assistantContent, hadSendError, lastNodeError, new AtomicBoolean(false));
    }

    void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError,
            AtomicBoolean wasAborted
    ) {
        if (line.startsWith("[STDIN_ERROR]")
                || line.startsWith("[STDIN_PARSE_ERROR]")
                || line.startsWith("[GET_SESSION_ERROR]")
                || line.startsWith("[PERSIST_ERROR]")) {
            lastNodeError.set(line);
        }

        if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                result.messages.add(msg);
                String type = msg.has("type") ? msg.get("type").getAsString() : "unknown";
                callback.onMessage(type, jsonStr);
            } catch (Exception ignored) {
            }
            return;
        }

        if (line.startsWith("[SEND_ERROR]")) {
            // If the request was aborted by the user, suppress the SEND_ERROR
            // so the UI does not show an error toast. The abort path in
            // ClaudeDaemonRequestExecutor handles completion gracefully.
            if (wasAborted.get()) {
                return;
            }
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj.has("error")) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError.set(true);
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
            return;
        }

        if (line.startsWith("[CONTENT]")) {
            String content = line.substring("[CONTENT]".length()).trim();
            assistantContent.append(content);
            callback.onMessage("content", content);
            return;
        }

        if (line.startsWith("[CONTENT_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[CONTENT_DELTA]".length()));
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
            return;
        }

        if (line.startsWith("[THINKING]")) {
            String thinkingContent = line.substring("[THINKING]".length()).trim();
            callback.onMessage("thinking", thinkingContent);
            return;
        }

        if (line.startsWith("[THINKING_DELTA]")) {
            String thinkingDelta = decodeJsonStringPayload(line.substring("[THINKING_DELTA]".length()));
            callback.onMessage("thinking_delta", thinkingDelta);
            return;
        }

        if (line.startsWith("[STREAM_START]")) {
            callback.onMessage("stream_start", "");
            return;
        }

        if (line.startsWith("[STREAM_END]")) {
            callback.onMessage("stream_end", "");
            return;
        }

        if (line.startsWith("[SESSION_ID]")) {
            callback.onMessage("session_id", line.substring("[SESSION_ID]".length()).trim());
            return;
        }

        if (line.startsWith("[TOOL_RESULT]")) {
            callback.onMessage("tool_result", line.substring("[TOOL_RESULT]".length()).trim());
            return;
        }

        if (line.startsWith("[USAGE]")) {
            callback.onMessage("usage", line.substring("[USAGE]".length()).trim());
            return;
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
            return;
        }

        if (line.startsWith("[BLOCK_RESET]")) {
            callback.onMessage("block_reset", "");
            return;
        }

        if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
        }
    }

    /**
     * Process a structured v2 envelope ({type, data}) emitted by protocol/emitter.js.
     * Mirrors the branch semantics of {@link #processOutputLine} so downstream
     * MessageCallback consumers see identical type strings and payloads.
     */
    void processEnvelope(
            String type,
            JsonElement data,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError,
            AtomicBoolean wasAborted
    ) {
        if (type == null) {
            return;
        }

        switch (type) {
            case "message": {
                if (data != null && data.isJsonObject()) {
                    JsonObject msg = data.getAsJsonObject();
                    result.messages.add(msg);
                    String msgType = msg.has("type") ? msg.get("type").getAsString() : "unknown";
                    callback.onMessage(msgType, gson.toJson(msg));
                }
                return;
            }

            case "send_error": {
                // If the request was aborted by the user, suppress the send_error
                // so the UI does not show an error toast. The abort path in
                // ClaudeDaemonRequestExecutor handles completion gracefully.
                if (wasAborted.get()) {
                    return;
                }
                String errorMessage = extractErrorMessage(data);
                hadSendError.set(true);
                result.success = false;
                result.error = errorMessage;
                callback.onError(errorMessage);
                return;
            }

            case "content": {
                String content = payloadAsString(data);
                assistantContent.append(content);
                callback.onMessage("content", content);
                return;
            }

            case "content_delta": {
                String delta = payloadAsString(data);
                assistantContent.append(delta);
                callback.onMessage("content_delta", delta);
                return;
            }

            case "thinking":
                callback.onMessage("thinking", payloadAsString(data));
                return;

            case "thinking_delta":
                callback.onMessage("thinking_delta", payloadAsString(data));
                return;

            case "stream_start":
            case "stream_end":
            case "message_start":
            case "block_reset":
            case "message_end":
                callback.onMessage(type, "");
                return;

            case "session_id":
                callback.onMessage("session_id", payloadAsString(data));
                return;

            case "tool_result":
                callback.onMessage("tool_result", payloadAsString(data));
                return;

            case "tool_preparing":
                // Emitted once per tool_use content_block_start, before the
                // input_json_delta argument stream. Payload: {name, index}.
                callback.onMessage("tool_preparing", payloadAsString(data));
                return;

            case "compact_status":
                // Normalized compaction lifecycle signal from ai-bridge
                // (system/status 'compacting' and system/compact_boundary).
                // Payload: {compacting, trigger?}.
                callback.onMessage("compact_status", payloadAsString(data));
                return;

            case "usage":
                callback.onMessage("usage", payloadAsString(data));
                return;

            case "node_error":
                // Mirrors the legacy [STDIN_ERROR]/[STDIN_PARSE_ERROR]/
                // [GET_SESSION_ERROR]/[PERSIST_ERROR] tag lines: keep the
                // "[SOURCE] message" text shape so existing "Details:" error
                // reporting reads the same.
                lastNodeError.set(formatNodeError(data));
                return;

            default:
                // Unknown envelope types (e.g. 'daemon', 'result', or future
                // additions) are ignored here; dedicated consumers handle them
                // via DaemonOutputCallback.onEnvelope.
        }
    }

    private String payloadAsString(JsonElement data) {
        if (data == null || data.isJsonNull()) {
            return "";
        }
        if (data.isJsonPrimitive() && data.getAsJsonPrimitive().isString()) {
            return data.getAsString();
        }
        return gson.toJson(data);
    }

    private String extractErrorMessage(JsonElement data) {
        if (data != null && data.isJsonObject()) {
            JsonElement error = data.getAsJsonObject().get("error");
            if (error != null && error.isJsonPrimitive()) {
                return error.getAsString();
            }
        }
        return payloadAsString(data);
    }

    private String formatNodeError(JsonElement data) {
        if (data != null && data.isJsonObject()) {
            JsonObject obj = data.getAsJsonObject();
            String source = obj.has("source") && !obj.get("source").isJsonNull()
                    ? obj.get("source").getAsString() : "NODE_ERROR";
            String message = obj.has("message") && !obj.get("message").isJsonNull()
                    ? obj.get("message").getAsString() : "";
            return "[" + source + "] " + message;
        }
        return "[NODE_ERROR] " + payloadAsString(data);
    }

    private String decodeJsonStringPayload(String rawPayload) {
        String jsonStr = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
        try {
            return gson.fromJson(jsonStr, String.class);
        } catch (Exception ignored) {
            return jsonStr;
        }
    }
}
