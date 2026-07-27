package com.codeaide.session;

import com.codeaide.session.ClaudeSession.Message;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Tests for the incremental upsert notifications emitted by CodexMessageHandler.
 *
 * <p>Mirrors {@link ClaudeMessageHandlerUpsertTest}: every structural mutation
 * during streaming (assistant raw merge, applied thinking delta, appended
 * tool_result user message) must fire
 * {@link CallbackHandler#notifyMessageUpsert(Message)} with the exact Message
 * instance that changed, BEFORE the full-list notifyMessageUpdate.  The
 * coalescer relies on that ordering: the first upsert activates upsert mode,
 * which suppresses the mid-stream full push.  Pure text deltas fire NEITHER —
 * they travel on the onContentDelta channel.
 */
public class CodexMessageHandlerUpsertTest {

    private RecordingCallbackHandler callbackHandler;
    private SessionState state;
    private CodexMessageHandler handler;

    @Before
    public void setUp() {
        callbackHandler = new RecordingCallbackHandler();
        state = new SessionState();
        handler = new CodexMessageHandler(state, callbackHandler);
    }

    @Test
    public void assistantMessageMergedIntoStreamingPlaceholderFiresUpsert() {
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "partial");
        callbackHandler.clear();

        String toolUseMessage = "{\"type\":\"assistant\",\"message\":{"
                + "\"content\":[{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"Bash\",\"input\":{}}]}}";
        handler.onMessage("assistant", toolUseMessage);

        assertEquals("one upsert for the assistant merge", 1, callbackHandler.upserts.size());
        Message upserted = callbackHandler.upserts.get(0);
        assertEquals(Message.Type.ASSISTANT, upserted.type);
        assertSame("upsert must carry the live Message instance held in state",
                upserted, state.getMessages().get(state.getMessages().size() - 1));
        assertTrue("upsert fires before the full-list update so upsert mode arms first",
                callbackHandler.events.indexOf("upsert") < callbackHandler.events.indexOf("update"));
    }

    @Test
    public void assistantMessageWithoutStreamingPlaceholderFiresUpsertForAppendedMessage() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        String toolUseMessage = "{\"type\":\"assistant\",\"message\":{"
                + "\"content\":[{\"type\":\"tool_use\",\"id\":\"call_2\",\"name\":\"Bash\",\"input\":{}}]}}";
        handler.onMessage("assistant", toolUseMessage);

        assertEquals(1, callbackHandler.upserts.size());
        Message upserted = callbackHandler.upserts.get(0);
        assertEquals(Message.Type.ASSISTANT, upserted.type);
        assertSame(upserted, state.getMessages().get(state.getMessages().size() - 1));
        assertTrue(callbackHandler.events.indexOf("upsert") < callbackHandler.events.indexOf("update"));
    }

    @Test
    public void thinkingDeltaFiresUpsertForCurrentAssistantMessage() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        handler.onMessage("thinking_delta", "reasoning step");

        assertEquals(1, callbackHandler.thinkingDeltas.size());
        assertEquals("applied thinking delta upserts the assistant message",
                1, callbackHandler.upserts.size());
        Message upserted = callbackHandler.upserts.get(0);
        assertEquals(Message.Type.ASSISTANT, upserted.type);
        assertSame(upserted, state.getMessages().get(state.getMessages().size() - 1));
    }

    @Test
    public void userMessageWithToolResultFiresUpsert() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        // Codex tool_result blocks carry tool_use_id derived from the call_id,
        // which the frontend upsert reducer uses for dedup.
        String toolResultUser = "{\"type\":\"user\",\"message\":{\"content\":"
                + "[{\"type\":\"tool_result\",\"tool_use_id\":\"call_1\",\"content\":\"ok\"}]}}";
        handler.onMessage("user", toolResultUser);

        assertEquals(1, callbackHandler.upserts.size());
        Message upserted = callbackHandler.upserts.get(0);
        assertEquals(Message.Type.USER, upserted.type);
        assertSame(upserted, state.getMessages().get(state.getMessages().size() - 1));
        assertTrue(callbackHandler.events.indexOf("upsert") < callbackHandler.events.indexOf("update"));
    }

    @Test
    public void contentDeltaDuringStreamingFiresNeitherUpsertNorFullUpdate() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        handler.onMessage("content_delta", "hello");

        // Text flows on the delta channel; per-delta full-list pushes are
        // exactly the O(conversation) IPC cost the upsert design removes.
        assertEquals(List.of("hello"), callbackHandler.contentDeltas);
        assertTrue("no upsert for pure text deltas", callbackHandler.upserts.isEmpty());
        assertTrue("no full update for pure text deltas mid-stream", callbackHandler.events.isEmpty());
        assertEquals("hello", state.getMessages().get(0).content);
    }

    @Test
    public void contentDeltaAfterStreamEndStillFiresFullUpdate() {
        handler.onMessage("stream_start", "");
        handler.onMessage("stream_end", "");
        callbackHandler.clear();

        // Late deltas arriving after stream_end must still reach the frontend;
        // outside streaming the full updateMessages channel covers them.
        handler.onMessage("content_delta", "late");

        assertEquals(List.of("late"), callbackHandler.contentDeltas);
        assertEquals(1, callbackHandler.events.stream().filter("update"::equals).count());
    }

    @Test
    public void usageAttachFiresNoUpsert() {
        handler.onMessage("stream_start", "");
        handler.onMessage("assistant", "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        callbackHandler.clear();

        // Usage attaches to the last assistant message's raw at turn end; the
        // authoritative stream-end flush carries it, so no incremental upsert.
        handler.onMessage("result", "{\"type\":\"result\",\"subtype\":\"usage\",\"usage\":{"
                + "\"input_tokens\":100,\"output_tokens\":10,\"cache_read_input_tokens\":0}}");

        assertTrue(callbackHandler.upserts.isEmpty());
    }

    /**
     * Records upsert/full-update notifications and their ordering.
     */
    private static class RecordingCallbackHandler extends CallbackHandler {
        final List<Message> upserts = new ArrayList<>();
        final List<String> thinkingDeltas = new ArrayList<>();
        final List<String> contentDeltas = new ArrayList<>();
        final List<String> events = new ArrayList<>();

        void clear() {
            upserts.clear();
            thinkingDeltas.clear();
            contentDeltas.clear();
            events.clear();
        }

        @Override
        public void notifyMessageUpsert(Message message) {
            upserts.add(message);
            events.add("upsert");
        }

        @Override
        public void notifyMessageUpdate(List<Message> messages) {
            events.add("update");
        }

        @Override
        public void notifyThinkingDelta(String delta) {
            thinkingDeltas.add(delta);
        }

        @Override
        public void notifyContentDelta(String delta) {
            contentDeltas.add(delta);
        }
    }
}
