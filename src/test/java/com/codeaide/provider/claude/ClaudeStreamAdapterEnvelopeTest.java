package com.codeaide.provider.claude;

import com.codeaide.provider.common.MessageCallback;
import com.codeaide.provider.common.SDKResult;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Covers the structured v2 envelope path ({type, data}) of ClaudeStreamAdapter,
 * mirroring the legacy tag-line coverage in ClaudeSDKBridgeRefactorTest.
 */
public class ClaudeStreamAdapterEnvelopeTest {

    private final Gson gson = new Gson();

    @Test
    public void envelopeMessageAddsRawObjectAndRoutesInnerType() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(gson);
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();

        JsonElement msg = JsonParser.parseString("{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\"}}");
        adapter.processEnvelope("message", msg, callback, result, new StringBuilder(),
                new AtomicBoolean(false), new AtomicReference<>(null), new AtomicBoolean(false));

        assertEquals(1, result.messages.size());
        assertTrue(result.messages.get(0) instanceof com.google.gson.JsonObject);
        assertEquals(1, callback.events.size());
        assertEquals("assistant", callback.events.get(0).type);
        assertEquals(gson.toJson(msg), callback.events.get(0).payload);
    }

    @Test
    public void envelopeDeltasAppendAssistantContent() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(gson);
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();

        adapter.processEnvelope("content_delta", str("Hello\nWorld"), callback, result, assistantContent,
                new AtomicBoolean(false), new AtomicReference<>(null), new AtomicBoolean(false));
        adapter.processEnvelope("thinking_delta", str("reasoning"), callback, result, assistantContent,
                new AtomicBoolean(false), new AtomicReference<>(null), new AtomicBoolean(false));
        adapter.processEnvelope("content", str("tail"), callback, result, assistantContent,
                new AtomicBoolean(false), new AtomicReference<>(null), new AtomicBoolean(false));

        assertEquals("Hello\nWorldtail", assistantContent.toString());
        assertEquals("content_delta", callback.events.get(0).type);
        assertEquals("Hello\nWorld", callback.events.get(0).payload);
        assertEquals("thinking_delta", callback.events.get(1).type);
        assertEquals("reasoning", callback.events.get(1).payload);
        assertEquals("content", callback.events.get(2).type);
        assertEquals("tail", callback.events.get(2).payload);
    }

    @Test
    public void envelopeMarkersAndScalarsRouteWithSameTypeStrings() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(gson);
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();

        AtomicBoolean hadSendError = new AtomicBoolean(false);
        AtomicReference<String> lastNodeError = new AtomicReference<>(null);
        AtomicBoolean wasAborted = new AtomicBoolean(false);
        StringBuilder assistantContent = new StringBuilder();

        adapter.processEnvelope("stream_start", null, callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);
        adapter.processEnvelope("block_reset", null, callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);
        adapter.processEnvelope("message_start", null, callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);
        adapter.processEnvelope("stream_end", null, callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);
        adapter.processEnvelope("message_end", null, callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);
        adapter.processEnvelope("session_id", str("session-123"), callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);
        adapter.processEnvelope("usage", JsonParser.parseString("{\"input_tokens\":1,\"output_tokens\":2}"),
                callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);
        adapter.processEnvelope("tool_result", JsonParser.parseString("{\"type\":\"tool_result\",\"content\":\"ok\"}"),
                callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);

        assertEquals("stream_start", callback.events.get(0).type);
        assertEquals("", callback.events.get(0).payload);
        assertEquals("block_reset", callback.events.get(1).type);
        assertEquals("message_start", callback.events.get(2).type);
        assertEquals("stream_end", callback.events.get(3).type);
        assertEquals("message_end", callback.events.get(4).type);
        assertEquals("session_id", callback.events.get(5).type);
        assertEquals("session-123", callback.events.get(5).payload);
        assertEquals("usage", callback.events.get(6).type);
        assertEquals("{\"input_tokens\":1,\"output_tokens\":2}", callback.events.get(6).payload);
        assertEquals("tool_result", callback.events.get(7).type);
        assertEquals("{\"type\":\"tool_result\",\"content\":\"ok\"}", callback.events.get(7).payload);
    }

    @Test
    public void envelopeSendErrorMarksFailureAndReportsError() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(gson);
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        AtomicBoolean hadSendError = new AtomicBoolean(false);

        adapter.processEnvelope("send_error", JsonParser.parseString("{\"success\":false,\"error\":\"boom\"}"),
                callback, result, new StringBuilder(),
                hadSendError, new AtomicReference<>(null), new AtomicBoolean(false));

        assertTrue(hadSendError.get());
        assertFalse(result.success);
        assertEquals("boom", result.error);
        assertEquals(1, callback.errors.size());
        assertEquals("boom", callback.errors.get(0));
    }

    @Test
    public void envelopeSendErrorSuppressedAfterUserAbort() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(gson);
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        AtomicBoolean hadSendError = new AtomicBoolean(false);

        adapter.processEnvelope("send_error", JsonParser.parseString("{\"error\":\"Request aborted by user\"}"),
                callback, result, new StringBuilder(),
                hadSendError, new AtomicReference<>(null), new AtomicBoolean(true));

        assertFalse(hadSendError.get());
        assertEquals(null, result.error);
        assertTrue(callback.errors.isEmpty());
    }

    @Test
    public void envelopeNodeErrorKeepsLegacyBracketTextShape() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(gson);
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        AtomicReference<String> lastNodeError = new AtomicReference<>(null);

        adapter.processEnvelope("node_error",
                JsonParser.parseString("{\"source\":\"STDIN_ERROR\",\"message\":\"read failed\"}"),
                callback, result, new StringBuilder(),
                new AtomicBoolean(false), lastNodeError, new AtomicBoolean(false));

        assertEquals("[STDIN_ERROR] read failed", lastNodeError.get());
        assertTrue(callback.events.isEmpty());
    }

    @Test
    public void envelopeUnknownTypeIsIgnored() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(gson);
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();

        adapter.processEnvelope("result", JsonParser.parseString("{\"success\":true}"),
                callback, result, new StringBuilder(),
                new AtomicBoolean(false), new AtomicReference<>(null), new AtomicBoolean(false));

        assertTrue(callback.events.isEmpty());
        assertTrue(callback.errors.isEmpty());
        assertEquals(0, result.messages.size());
    }

    @Test
    public void envelopeToolPreparingRoutesNamePayload() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(gson);
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();

        adapter.processEnvelope("tool_preparing",
                JsonParser.parseString("{\"name\":\"Write\",\"index\":1}"),
                callback, result, new StringBuilder(),
                new AtomicBoolean(false), new AtomicReference<>(null), new AtomicBoolean(false));

        assertEquals(1, callback.events.size());
        assertEquals("tool_preparing", callback.events.get(0).type);
        assertEquals("{\"name\":\"Write\",\"index\":1}", callback.events.get(0).payload);
        assertEquals(0, result.messages.size());
    }

    @Test
    public void envelopeCompactStatusRoutesCompactingPayload() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(gson);
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();

        adapter.processEnvelope("compact_status",
                JsonParser.parseString("{\"compacting\":true}"),
                callback, result, new StringBuilder(),
                new AtomicBoolean(false), new AtomicReference<>(null), new AtomicBoolean(false));
        adapter.processEnvelope("compact_status",
                JsonParser.parseString("{\"compacting\":false,\"trigger\":\"auto\"}"),
                callback, result, new StringBuilder(),
                new AtomicBoolean(false), new AtomicReference<>(null), new AtomicBoolean(false));

        assertEquals(2, callback.events.size());
        assertEquals("compact_status", callback.events.get(0).type);
        assertEquals("{\"compacting\":true}", callback.events.get(0).payload);
        assertEquals("compact_status", callback.events.get(1).type);
        assertEquals("{\"compacting\":false,\"trigger\":\"auto\"}", callback.events.get(1).payload);
    }

    @Test
    public void envelopeTaskEventRoutesJsonPayload() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(gson);
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();

        adapter.processEnvelope("task_event",
                JsonParser.parseString("{\"kind\":\"progress\",\"taskId\":\"t1\",\"toolUseId\":\"toolu_1\",\"lastToolName\":\"Glob\"}"),
                callback, result, new StringBuilder(),
                new AtomicBoolean(false), new AtomicReference<>(null), new AtomicBoolean(false));
        adapter.processEnvelope("task_event",
                JsonParser.parseString("{\"kind\":\"tool_progress\",\"toolName\":\"Bash\",\"elapsedTimeSeconds\":12}"),
                callback, result, new StringBuilder(),
                new AtomicBoolean(false), new AtomicReference<>(null), new AtomicBoolean(false));

        assertEquals(2, callback.events.size());
        assertEquals("task_event", callback.events.get(0).type);
        assertEquals("{\"kind\":\"progress\",\"taskId\":\"t1\",\"toolUseId\":\"toolu_1\",\"lastToolName\":\"Glob\"}",
                callback.events.get(0).payload);
        assertEquals("task_event", callback.events.get(1).type);
        // Task events must never leak into the message list
        assertEquals(0, result.messages.size());
    }

    @Test
    public void envelopeSubagentMessageRoutesJsonPayload() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(gson);
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();

        adapter.processEnvelope("subagent_message",
                JsonParser.parseString("{\"parentToolUseId\":\"toolu_1\",\"role\":\"assistant\",\"blocks\":[{\"type\":\"tool_use\",\"id\":\"s1\",\"name\":\"Glob\"}]}"),
                callback, result, new StringBuilder(),
                new AtomicBoolean(false), new AtomicReference<>(null), new AtomicBoolean(false));

        assertEquals(1, callback.events.size());
        assertEquals("subagent_message", callback.events.get(0).type);
        assertEquals("{\"parentToolUseId\":\"toolu_1\",\"role\":\"assistant\",\"blocks\":[{\"type\":\"tool_use\",\"id\":\"s1\",\"name\":\"Glob\"}]}",
                callback.events.get(0).payload);
        // Sidechain steps must not be merged into the main assistant bubble
        assertEquals(0, result.messages.size());
    }

    private JsonElement str(String value) {
        return JsonParser.parseString(gson.toJson(value));
    }

    private static class RecordingCallback implements MessageCallback {
        private final List<Event> events = new ArrayList<>();
        private final List<String> errors = new ArrayList<>();

        @Override
        public void onMessage(String type, String content) {
            events.add(new Event(type, content));
        }

        @Override
        public void onError(String error) {
            errors.add(error);
        }

        @Override
        public void onComplete(SDKResult result) {
        }
    }

    private static class Event {
        private final String type;
        private final String payload;

        private Event(String type, String payload) {
            this.type = type;
            this.payload = payload;
        }
    }
}
