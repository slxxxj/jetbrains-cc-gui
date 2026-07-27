package com.codeaide.provider.common;

import com.google.gson.JsonElement;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class DaemonBridgeTest {

    // HEARTBEAT_TIMEOUT_MS = 45_000; just over threshold triggers unresponsive
    private static final long JUST_OVER_HEARTBEAT_THRESHOLD = 46_000;
    // ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS = 180_000; well over for active-request timeout
    private static final long OVER_ACTIVE_REQUEST_THRESHOLD = 190_000;
    // Recent activity within threshold
    private static final long RECENT_ACTIVITY = 5_000;

    @Test
    public void staleHeartbeatWithoutActiveRequestsIsUnresponsive() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, JUST_OVER_HEARTBEAT_THRESHOLD, 0));
    }

    @Test
    public void activeRequestWithRecentOutputGetsGraceWindow() {
        assertFalse(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, RECENT_ACTIVITY, 1));
    }

    @Test
    public void activeRequestWithNoRecentOutputEventuallyTimesOut() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(OVER_ACTIVE_REQUEST_THRESHOLD, OVER_ACTIVE_REQUEST_THRESHOLD, 1));
    }

    @Test
    public void structuredEnvelopeIsDispatchedToOnEnvelope() {
        DaemonBridge bridge = new DaemonBridge(null, null, null);
        RecordingCallback callback = new RecordingCallback();
        bridge.addPendingRequestForTest("1", callback);

        bridge.handleDaemonOutput("{\"id\":\"1\",\"type\":\"content_delta\",\"data\":\"Hello\"}");

        assertEquals(1, callback.envelopes.size());
        assertEquals("content_delta", callback.envelopes.get(0).type);
        assertEquals("Hello", callback.envelopes.get(0).data.getAsString());
        assertTrue(callback.lines.isEmpty());
    }

    @Test
    public void structuredMessageEnvelopeCarriesObjectData() {
        DaemonBridge bridge = new DaemonBridge(null, null, null);
        RecordingCallback callback = new RecordingCallback();
        bridge.addPendingRequestForTest("1", callback);

        bridge.handleDaemonOutput("{\"id\":\"1\",\"type\":\"message\",\"data\":{\"type\":\"assistant\"}}");

        assertEquals(1, callback.envelopes.size());
        assertEquals("message", callback.envelopes.get(0).type);
        assertTrue(callback.envelopes.get(0).data.isJsonObject());
        assertEquals("assistant", callback.envelopes.get(0).data.getAsJsonObject().get("type").getAsString());
    }

    @Test
    public void legacyLineEnvelopeStillFallsBackToOnLine() {
        DaemonBridge bridge = new DaemonBridge(null, null, null);
        RecordingCallback callback = new RecordingCallback();
        bridge.addPendingRequestForTest("1", callback);

        bridge.handleDaemonOutput("{\"id\":\"1\",\"line\":\"[MESSAGE] {}\"}");

        assertEquals(1, callback.lines.size());
        assertEquals("[MESSAGE] {}", callback.lines.get(0));
        assertTrue(callback.envelopes.isEmpty());
    }

    @Test
    public void doneEnvelopeCompletesWithoutOnEnvelope() {
        DaemonBridge bridge = new DaemonBridge(null, null, null);
        RecordingCallback callback = new RecordingCallback();
        bridge.addPendingRequestForTest("1", callback);

        bridge.handleDaemonOutput("{\"id\":\"1\",\"done\":true,\"success\":true}");

        assertEquals(1, callback.completions.size());
        assertTrue(callback.completions.get(0));
        assertTrue(callback.envelopes.isEmpty());
    }

    @Test
    public void daemonAndHeartbeatTypesNeverReachOnEnvelope() {
        DaemonBridge bridge = new DaemonBridge(null, null, null);
        RecordingCallback callback = new RecordingCallback();
        bridge.addPendingRequestForTest("1", callback);

        bridge.handleDaemonOutput("{\"type\":\"daemon\",\"event\":\"log\",\"message\":\"noise\"}");
        bridge.handleDaemonOutput("{\"id\":\"hb-1\",\"type\":\"heartbeat\",\"ts\":123}");
        bridge.handleDaemonOutput("{\"id\":\"1\",\"type\":\"status\",\"version\":\"1.0.0\"}");

        assertTrue(callback.envelopes.isEmpty());
        assertTrue(callback.lines.isEmpty());
    }

    @Test
    public void permissionRequestIsDispatchedToEventListenersNotRequestHandlers() {
        DaemonBridge bridge = new DaemonBridge(null, null, null);
        RecordingCallback callback = new RecordingCallback();
        bridge.addPendingRequestForTest("1", callback);

        List<String> events = new ArrayList<>();
        List<com.google.gson.JsonObject> payloads = new ArrayList<>();
        bridge.addEventListener((event, data) -> {
            events.add(event);
            payloads.add(data);
        });

        bridge.handleDaemonOutput("{\"type\":\"permission_request\",\"requestId\":\"req-1\","
                + "\"payload\":{\"kind\":\"tool\",\"toolName\":\"Bash\",\"input\":{\"command\":\"ls\"}}}");

        // Reached the event listener exactly once, with the full envelope.
        assertEquals(1, events.size());
        assertEquals("permission_request", events.get(0));
        assertEquals("req-1", payloads.get(0).get("requestId").getAsString());
        assertEquals("Bash", payloads.get(0).getAsJsonObject("payload").get("toolName").getAsString());

        // Never misrouted to the pending request handler despite no id tag.
        assertTrue(callback.envelopes.isEmpty());
        assertTrue(callback.lines.isEmpty());
    }

    @Test
    public void lifecycleListenersAreNotifiedOnReady() {
        DaemonBridge bridge = new DaemonBridge(null, null, null);

        List<String> calls = new ArrayList<>();
        DaemonBridge.DaemonLifecycleListener listener = new DaemonBridge.DaemonLifecycleListener() {
            @Override
            public void onDaemonReady() {
                calls.add("ready");
            }

            @Override
            public void onDaemonDied() {
                calls.add("died");
            }
        };
        bridge.addLifecycleListener(listener);

        bridge.handleDaemonOutput("{\"type\":\"daemon\",\"event\":\"ready\",\"pid\":1,\"sdkPreloaded\":true}");
        assertEquals(List.of("ready"), calls);

        bridge.removeLifecycleListener(listener);
        bridge.handleDaemonOutput("{\"type\":\"daemon\",\"event\":\"ready\",\"pid\":1,\"sdkPreloaded\":true}");
        assertEquals(List.of("ready"), calls);
    }

    private static class RecordingCallback implements DaemonBridge.DaemonOutputCallback {
        private final List<String> lines = new ArrayList<>();
        private final List<Envelope> envelopes = new ArrayList<>();
        private final List<Boolean> completions = new ArrayList<>();

        @Override
        public void onLine(String line) {
            lines.add(line);
        }

        @Override
        public void onStderr(String text) {
        }

        @Override
        public void onError(String error) {
        }

        @Override
        public void onComplete(boolean success) {
            completions.add(success);
        }

        @Override
        public void onEnvelope(String type, JsonElement data) {
            envelopes.add(new Envelope(type, data));
        }
    }

    private static class Envelope {
        private final String type;
        private final JsonElement data;

        private Envelope(String type, JsonElement data) {
            this.type = type;
            this.data = data;
        }
    }
}
