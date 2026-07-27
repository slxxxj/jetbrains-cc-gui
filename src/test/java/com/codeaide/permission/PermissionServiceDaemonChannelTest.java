package com.codeaide.permission;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

/**
 * Covers the daemon out-of-band permission channel on the Java side:
 * envelope translation ({@link PermissionService#buildDaemonRequest}),
 * decision serialization ({@link DaemonPermissionResponseChannel}), and the
 * deny-on-malformed entry path of
 * {@link PermissionService#handleDaemonPermissionRequest}.
 */
public class PermissionServiceDaemonChannelTest {

    // ── buildDaemonRequest ─────────────────────────────────────────────

    @Test
    public void buildDaemonRequestMapsToolKind() {
        JsonObject envelope = JsonParser.parseString(
                "{\"type\":\"permission_request\",\"requestId\":\"req-1\",\"payload\":{"
                        + "\"kind\":\"tool\",\"toolName\":\"Bash\",\"input\":{\"command\":\"ls\"},"
                        + "\"sessionId\":\"sess\",\"cwd\":\"/repo\",\"timestamp\":\"t\"}}")
                .getAsJsonObject();

        JsonObject request = PermissionService.buildDaemonRequest(envelope);

        assertNotNull(request);
        assertEquals("req-1", request.get("requestId").getAsString());
        assertEquals("tool", request.get("__kind").getAsString());
        assertEquals("Bash", request.get("toolName").getAsString());
        assertEquals("ls", request.getAsJsonObject("inputs").get("command").getAsString());
        // cwd preserved for multi-project dialog routing (same capability as the file protocol)
        assertEquals("/repo", request.get("cwd").getAsString());
    }

    @Test
    public void buildDaemonRequestMapsAskUserQuestionKind() {
        JsonObject envelope = JsonParser.parseString(
                "{\"type\":\"permission_request\",\"requestId\":\"ask-1\",\"payload\":{"
                        + "\"kind\":\"ask_user_question\",\"toolName\":\"AskUserQuestion\","
                        + "\"questions\":[{\"question\":\"Pick one\"}],\"cwd\":\"/repo\"}}")
                .getAsJsonObject();

        JsonObject request = PermissionService.buildDaemonRequest(envelope);

        assertNotNull(request);
        assertEquals("ask-1", request.get("requestId").getAsString());
        assertEquals("ask_user_question", request.get("__kind").getAsString());
        assertEquals("AskUserQuestion", request.get("toolName").getAsString());
        assertEquals(1, request.getAsJsonArray("questions").size());
    }

    @Test
    public void buildDaemonRequestMapsPlanApprovalKind() {
        JsonObject envelope = JsonParser.parseString(
                "{\"type\":\"permission_request\",\"requestId\":\"plan-1\",\"payload\":{"
                        + "\"kind\":\"plan_approval\",\"toolName\":\"ExitPlanMode\",\"plan\":\"do it\","
                        + "\"allowedPrompts\":[{\"tool\":\"Bash\",\"prompt\":\"run tests\"}]}}")
                .getAsJsonObject();

        JsonObject request = PermissionService.buildDaemonRequest(envelope);

        assertNotNull(request);
        assertEquals("plan-1", request.get("requestId").getAsString());
        assertEquals("plan_approval", request.get("__kind").getAsString());
        assertEquals("ExitPlanMode", request.get("toolName").getAsString());
        assertEquals("do it", request.get("plan").getAsString());
        assertEquals(1, request.getAsJsonArray("allowedPrompts").size());
    }

    @Test
    public void buildDaemonRequestRejectsMalformedPayloads() {
        assertNull(PermissionService.buildDaemonRequest(null));
        assertNull(PermissionService.buildDaemonRequest(new JsonObject()));
        assertNull(PermissionService.buildDaemonRequest(JsonParser.parseString(
                "{\"requestId\":\"r\",\"payload\":{}}").getAsJsonObject()));
        assertNull(PermissionService.buildDaemonRequest(JsonParser.parseString(
                "{\"requestId\":\"r\",\"payload\":{\"kind\":\"unknown\"}}").getAsJsonObject()));
        assertNull(PermissionService.buildDaemonRequest(JsonParser.parseString(
                "{\"requestId\":\"r\",\"payload\":{\"kind\":\"tool\"}}").getAsJsonObject()));
        assertNull(PermissionService.buildDaemonRequest(JsonParser.parseString(
                "{\"requestId\":\"r\",\"payload\":\"not-an-object\"}").getAsJsonObject()));
    }

    @Test
    public void buildDaemonRequestDefaultsMissingToolInputToEmptyObject() {
        JsonObject envelope = JsonParser.parseString(
                "{\"type\":\"permission_request\",\"requestId\":\"req-2\",\"payload\":{"
                        + "\"kind\":\"tool\",\"toolName\":\"Bash\"}}")
                .getAsJsonObject();

        JsonObject request = PermissionService.buildDaemonRequest(envelope);

        assertNotNull(request);
        assertNotNull(request.getAsJsonObject("inputs"));
        assertEquals(0, request.getAsJsonObject("inputs").size());
    }

    // ── DaemonPermissionResponseChannel ────────────────────────────────

    @Test
    public void responseChannelSerializesPermissionDecision() {
        List<JsonObject> sent = new ArrayList<>();
        DaemonPermissionResponseChannel channel = new DaemonPermissionResponseChannel("req-1", sent::add);

        channel.writePermissionResponse("req-1", true);

        assertEquals(1, sent.size());
        JsonObject envelope = sent.get(0);
        assertEquals("permission_response", envelope.get("type").getAsString());
        assertEquals("req-1", envelope.get("requestId").getAsString());
        assertTrue(envelope.getAsJsonObject("decision").get("allow").getAsBoolean());
    }

    @Test
    public void responseChannelSerializesAskAndPlanDecisions() {
        List<JsonObject> sent = new ArrayList<>();
        DaemonPermissionResponseChannel channel = new DaemonPermissionResponseChannel("req-2", sent::add);

        JsonObject answers = new JsonObject();
        answers.addProperty("Q", "A");
        channel.writeAskUserQuestionResponse("req-2", answers);
        channel.writePlanApprovalResponse("req-2", false, "default");

        JsonObject ask = sent.get(0);
        assertEquals("A", ask.getAsJsonObject("decision").getAsJsonObject("answers").get("Q").getAsString());

        JsonObject plan = sent.get(1);
        assertFalse(plan.getAsJsonObject("decision").get("approved").getAsBoolean());
        assertEquals("default", plan.getAsJsonObject("decision").get("targetMode").getAsString());
    }

    @Test
    public void responseChannelSwallowsSenderFailures() {
        DaemonPermissionResponseChannel channel = new DaemonPermissionResponseChannel("req-3", envelope -> {
            throw new RuntimeException("daemon gone");
        });
        // Must not throw: the Node-side safety-net timeout denies instead.
        channel.writePermissionResponse("req-3", false);
    }

    // ── handleDaemonPermissionRequest entry paths ──────────────────────

    @Test
    public void daemonRequestWithoutRequestIdIsDroppedSilently() {
        PermissionService service = new PermissionService(null, "test-session");
        try {
            List<JsonObject> sent = new ArrayList<>();
            service.handleDaemonPermissionRequest(
                    JsonParser.parseString("{\"type\":\"permission_request\",\"payload\":{\"kind\":\"tool\"}}")
                            .getAsJsonObject(),
                    sent::add);
            assertTrue(sent.isEmpty());
        } finally {
            service.stop();
        }
    }

    @Test
    public void malformedDaemonRequestGetsExplicitDeny() {
        PermissionService service = new PermissionService(null, "test-session");
        try {
            List<JsonObject> sent = new ArrayList<>();
            service.handleDaemonPermissionRequest(
                    JsonParser.parseString("{\"type\":\"permission_request\",\"requestId\":\"req-9\","
                            + "\"payload\":{\"kind\":\"bogus\"}}").getAsJsonObject(),
                    sent::add);

            assertEquals(1, sent.size());
            JsonObject envelope = sent.get(0);
            assertEquals("permission_response", envelope.get("type").getAsString());
            assertEquals("req-9", envelope.get("requestId").getAsString());
            // Explicit deny shape; the Node side maps it to deny for every kind.
            assertFalse(envelope.getAsJsonObject("decision").get("allow").getAsBoolean());
        } finally {
            service.stop();
        }
    }

    @Test
    public void ensureFileWatcherForSessionIsSafeWithoutInstance() {
        // Lookup-only: must never create an instance or throw.
        PermissionService.ensureFileWatcherForSession("no-such-session");
        PermissionService.ensureFileWatcherForSession(null);
    }
}
