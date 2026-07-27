package com.codeaide.permission;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.function.Consumer;

/**
 * Daemon-mode response channel: serializes the decision as an out-of-band
 * {@code {"type":"permission_response","requestId":...,"decision":{...}}}
 * envelope and hands it to the sender (which writes it to the daemon's
 * stdin, bypassing the command queue).
 */
class DaemonPermissionResponseChannel implements PermissionResponseChannel {

    private static final Logger LOG = Logger.getInstance(DaemonPermissionResponseChannel.class);

    private final String requestId;
    private final Consumer<JsonObject> sender;

    DaemonPermissionResponseChannel(String requestId, Consumer<JsonObject> sender) {
        this.requestId = requestId;
        this.sender = sender;
    }

    @Override
    public void writePermissionResponse(String requestId, boolean allow) {
        JsonObject decision = new JsonObject();
        decision.addProperty("allow", allow);
        send(buildEnvelope(decision));
    }

    @Override
    public void writeAskUserQuestionResponse(String requestId, JsonObject answers) {
        JsonObject decision = new JsonObject();
        decision.add("answers", answers != null ? answers : new JsonObject());
        send(buildEnvelope(decision));
    }

    @Override
    public void writePlanApprovalResponse(String requestId, boolean approved, String targetMode) {
        JsonObject decision = new JsonObject();
        decision.addProperty("approved", approved);
        decision.addProperty("targetMode", targetMode != null ? targetMode : "default");
        send(buildEnvelope(decision));
    }

    JsonObject buildEnvelope(JsonObject decision) {
        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "permission_response");
        envelope.addProperty("requestId", requestId);
        envelope.add("decision", decision);
        return envelope;
    }

    private void send(JsonObject envelope) {
        try {
            sender.accept(envelope);
        } catch (Exception e) {
            // If the daemon died between prompt and decision, the Node-side
            // safety-net timeout denies the request. Never throw into dialog code.
            LOG.debug("Failed to send daemon permission response: " + e.getMessage());
        }
    }
}
