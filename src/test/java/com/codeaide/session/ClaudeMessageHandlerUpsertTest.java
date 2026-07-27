package com.codeaide.session;

import com.codeaide.session.ClaudeSession.Message;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Tests for the incremental upsert notifications emitted by ClaudeMessageHandler.
 *
 * <p>Every structural mutation during streaming (assistant raw merge, applied
 * thinking delta, tool_result user message) must fire
 * {@link CallbackHandler#notifyMessageUpsert(Message)} with the exact Message
 * instance that changed, BEFORE the full-list notifyMessageUpdate.  The
 * coalescer relies on that ordering: the first upsert activates upsert mode,
 * which suppresses the mid-stream full push.
 */
public class ClaudeMessageHandlerUpsertTest {

    private RecordingCallbackHandler callbackHandler;
    private SessionState state;
    private ClaudeMessageHandler handler;

    @Before
    public void setUp() {
        callbackHandler = new RecordingCallbackHandler();
        state = new SessionState();
        handler = new ClaudeMessageHandler(
                null, // project not needed for these tests
                state,
                callbackHandler,
                new MessageParser(),
                new MessageMerger(),
                new GsonBuilder().create()
        );
    }

    @Test
    public void assistantMessageFiresUpsertWithCurrentAssistantMessage() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        String toolUseMessage = "{\"type\":\"assistant\",\"uuid\":\"u-1\",\"message\":{"
                + "\"content\":[{\"type\":\"tool_use\",\"id\":\"tu-1\",\"name\":\"Bash\",\"input\":{}}]}}";
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
    public void thinkingDeltaFiresUpsertForCurrentAssistantMessage() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        handler.onMessage("thinking_delta", "reasoning step");

        assertEquals(1, callbackHandler.thinkingDeltas.size());
        assertEquals("applied thinking delta upserts the assistant message",
                1, callbackHandler.upserts.size());
        assertEquals(Message.Type.ASSISTANT, callbackHandler.upserts.get(0).type);
    }

    @Test
    public void skippedThinkingDeltaReplayFiresNoUpsert() {
        handler.onMessage("stream_start", "");

        // Conservative sync: the full assistant message already carries the
        // thinking content, so the SDK's replayed deltas are swallowed.
        String fullMessage = "{\"type\":\"assistant\",\"message\":{\"content\":["
                + "{\"type\":\"thinking\",\"thinking\":\"Let me think\",\"text\":\"Let me think\"}"
                + "]}}";
        handler.onMessage("assistant", fullMessage);
        callbackHandler.clear();

        handler.onMessage("thinking_delta", "Let ");
        handler.onMessage("thinking_delta", "me ");
        handler.onMessage("thinking_delta", "think");

        assertTrue(callbackHandler.thinkingDeltas.isEmpty());
        assertTrue("no upsert when the delta was not applied", callbackHandler.upserts.isEmpty());
    }

    @Test
    public void userMessageWithToolResultFiresUpsert() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        String toolResultUser = "{\"type\":\"user\",\"uuid\":\"u-9\",\"message\":{\"content\":"
                + "[{\"type\":\"tool_result\",\"tool_use_id\":\"tu-1\",\"content\":\"ok\"}]}}";
        handler.onMessage("user", toolResultUser);

        assertEquals(1, callbackHandler.upserts.size());
        Message upserted = callbackHandler.upserts.get(0);
        assertEquals(Message.Type.USER, upserted.type);
        assertSame(upserted, state.getMessages().get(state.getMessages().size() - 1));
    }

    @Test
    public void toolResultEnvelopeFiresUpsert() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        String toolResult = "{\"type\":\"tool_result\",\"tool_use_id\":\"tu-2\",\"content\":\"done\"}";
        handler.onMessage("tool_result", toolResult);

        assertEquals(1, callbackHandler.upserts.size());
        Message upserted = callbackHandler.upserts.get(0);
        assertEquals(Message.Type.USER, upserted.type);
        assertSame(upserted, state.getMessages().get(state.getMessages().size() - 1));
    }

    @Test
    public void plainUserMessageFiresNoUpsert() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        // A plain user message only patches the uuid of the optimistic copy;
        // that travels on the dedicated patchMessageUuid channel, not upsert.
        String plainUser = "{\"type\":\"user\",\"uuid\":\"u-7\",\"message\":"
                + "{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}";
        handler.onMessage("user", plainUser);

        assertTrue(callbackHandler.upserts.isEmpty());
    }

    /**
     * Records upsert/full-update notifications and their ordering.
     */
    private static class RecordingCallbackHandler extends CallbackHandler {
        final List<Message> upserts = new ArrayList<>();
        final List<String> thinkingDeltas = new ArrayList<>();
        final List<String> events = new ArrayList<>();

        void clear() {
            upserts.clear();
            thinkingDeltas.clear();
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
    }
}
