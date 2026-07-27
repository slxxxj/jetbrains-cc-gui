package com.codeaide.session;

import com.google.gson.GsonBuilder;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Tests for the transient streaming status-hint signals routed by
 * {@link ClaudeMessageHandler}: tool_preparing (tool_use argument generation
 * phase) and compact_status (context compaction lifecycle). Both are pure
 * pass-throughs to the session callback — the handler keeps no hint state, so
 * cleanup paths (stream_end, error, block_reset) need no handler changes.
 */
public class ClaudeMessageHandlerStatusHintTest {

    private RecordingCallbackHandler callbackHandler;
    private ClaudeMessageHandler handler;

    @Before
    public void setUp() {
        callbackHandler = new RecordingCallbackHandler();
        handler = new ClaudeMessageHandler(
                null, // project not needed for these tests
                new SessionState(),
                callbackHandler,
                new MessageParser(),
                new MessageMerger(),
                new GsonBuilder().create()
        );
    }

    @Test
    public void toolPreparingExtractsNameAndNotifies() {
        handler.onMessage("tool_preparing", "{\"name\":\"Write\",\"index\":1}");

        assertEquals(1, callbackHandler.toolPreparingNames.size());
        assertEquals("Write", callbackHandler.toolPreparingNames.get(0));
    }

    @Test
    public void toolPreparingWithMissingNameDegradesToEmptyString() {
        handler.onMessage("tool_preparing", "{\"index\":0}");

        assertEquals(1, callbackHandler.toolPreparingNames.size());
        assertEquals("", callbackHandler.toolPreparingNames.get(0));
    }

    @Test
    public void toolPreparingWithMalformedJsonStillNotifiesEmptyName() {
        handler.onMessage("tool_preparing", "not-json");

        assertEquals(1, callbackHandler.toolPreparingNames.size());
        assertEquals("", callbackHandler.toolPreparingNames.get(0));
    }

    @Test
    public void compactStatusParsesCompactingFlag() {
        handler.onMessage("compact_status", "{\"compacting\":true}");
        handler.onMessage("compact_status", "{\"compacting\":false,\"trigger\":\"auto\"}");

        assertEquals(2, callbackHandler.compactStatuses.size());
        assertTrue(callbackHandler.compactStatuses.get(0));
        assertEquals(Boolean.FALSE, callbackHandler.compactStatuses.get(1));
    }

    @Test
    public void compactStatusWithMalformedJsonDefaultsToNotCompacting() {
        handler.onMessage("compact_status", "garbage");

        assertEquals(1, callbackHandler.compactStatuses.size());
        assertEquals(Boolean.FALSE, callbackHandler.compactStatuses.get(0));
    }

    /**
     * Records the hint notifications; mirrors the style of
     * ClaudeMessageHandlerUpsertTest.RecordingCallbackHandler.
     */
    private static class RecordingCallbackHandler extends CallbackHandler {
        final List<String> toolPreparingNames = new ArrayList<>();
        final List<Boolean> compactStatuses = new ArrayList<>();

        @Override
        public void notifyToolPreparing(String toolName) {
            toolPreparingNames.add(toolName);
        }

        @Override
        public void notifyCompactStatus(boolean compacting) {
            compactStatuses.add(compacting);
        }
    }
}
