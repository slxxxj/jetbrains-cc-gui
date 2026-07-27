package com.codeaide.permission;

import com.google.gson.JsonObject;

/**
 * Transport abstraction for permission decisions flowing back to the Node
 * process. Two implementations exist:
 * - {@link PermissionFileProtocol}: writes response files polled by the
 *   per-process Node bridge (fallback when no daemon is available).
 * - {@link DaemonPermissionResponseChannel}: sends an out-of-band
 *   permission_response envelope over the daemon's stdin.
 */
interface PermissionResponseChannel {

    void writePermissionResponse(String requestId, boolean allow);

    void writeAskUserQuestionResponse(String requestId, JsonObject answers);

    void writePlanApprovalResponse(String requestId, boolean approved, String targetMode);
}
