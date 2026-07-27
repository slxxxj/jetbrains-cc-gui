package com.codeaide.permission;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import javax.swing.*;
import java.nio.file.*;
import java.util.Set;
import java.util.concurrent.*;
import java.util.function.Consumer;

/**
 * Permission service - handles permission requests from the Node.js process
 */
public class PermissionService {

    private static final Logger LOG = Logger.getInstance(PermissionService.class);

    private final Project project;
    private final Path permissionDir;
    private final String sessionId;
    private final Gson gson = new Gson();
    private volatile long lastActivityTime = System.currentTimeMillis();
    private volatile PermissionDecisionListener decisionListener;

    private static final int DIALOG_SHOWER_POLL_INTERVAL_MS = 100;
    private static final int DIALOG_SHOWER_POLL_MAX_ATTEMPTS = 20;

    private final PermissionDecisionStore decisionStore;
    private final PermissionDialogRouter dialogRouter;
    private final PermissionFileProtocol fileProtocol;
    private final PermissionRequestWatcher requestWatcher;

    // Watcher lifecycle state: the file watcher is the per-process fallback.
    // While the daemon channel is active (daemon ready) it is stopped; any
    // per-process spawn or daemon death reactivates it.
    private volatile boolean daemonChannelActive;
    private volatile boolean started;
    private volatile PermissionRequestWatcher.RequestHandler watcherHandler;

    // Daemon-sourced permission requests arrive on the DaemonBridge reader
    // thread; they are handled here so a blocking fallback dialog can never
    // stall daemon stdout processing (heartbeats, stream events).
    private final ExecutorService daemonRequestExecutor = Executors.newCachedThreadPool(r -> {
        Thread thread = new Thread(r, "PermissionService-DaemonRequests");
        thread.setDaemon(true);
        return thread;
    });

    // Track request files currently being processed to avoid duplicate handling
    private final Set<String> processingRequests = ConcurrentHashMap.newKeySet();

    private void debugLog(String tag, String message) {
        LOG.debug(String.format("[%s] %s", tag, message));
    }

    private void debugLog(String tag, String message, Object data) {
        LOG.debug(String.format("[%s] %s | Data: %s", tag, message, this.gson.toJson(data)));
    }

    // ── Enums & Inner Types ────────────────────────────────────────────

    public enum PermissionResponse {
        ALLOW(1, "Allow"),
        ALLOW_ALWAYS(2, "Allow and don't ask again"),
        DENY(3, "Deny");

        private final int value;
        private final String description;

        PermissionResponse(int value, String description) {
            this.value = value;
            this.description = description;
        }

        public int getValue() { return value; }
        public String getDescription() { return description; }

        public static PermissionResponse fromValue(int value) {
            for (PermissionResponse response : values()) {
                if (response.value == value) { return response; }
            }
            return null;
        }

        public boolean isAllow() { return this == ALLOW || this == ALLOW_ALWAYS; }
    }

    public static class PermissionDecision {
        private final String toolName;
        private final JsonObject inputs;
        private final PermissionResponse response;

        public PermissionDecision(String toolName, JsonObject inputs, PermissionResponse response) {
            this.toolName = toolName;
            this.inputs = inputs;
            this.response = response;
        }

        public String getToolName() { return toolName; }
        public JsonObject getInputs() { return inputs; }
        public PermissionResponse getResponse() { return response; }

        public boolean isAllowed() {
            return response != null && response.isAllow();
        }
    }

    public interface PermissionDecisionListener {
        void onDecision(PermissionDecision decision);
    }

    public interface PermissionDialogShower {
        CompletableFuture<Integer> showPermissionDialog(String toolName, JsonObject inputs);
    }

    public interface AskUserQuestionDialogShower {
        CompletableFuture<JsonObject> showAskUserQuestionDialog(String requestId, JsonObject questions);
    }

    public interface PlanApprovalDialogShower {
        CompletableFuture<JsonObject> showPlanApprovalDialog(String requestId, JsonObject planData);
    }

    // ── Constructor & Factory Methods ──────────────────────────────────

    PermissionService(Project project, String sessionId) {
        this.project = project;
        this.sessionId = sessionId;

        String envDir = System.getenv("CLAUDE_PERMISSION_DIR");
        if (envDir != null && !envDir.trim().isEmpty()) {
            this.permissionDir = Paths.get(envDir);
            debugLog("INIT", "Using permission dir from env CLAUDE_PERMISSION_DIR: " + envDir);
        } else {
            this.permissionDir = Paths.get(System.getProperty("java.io.tmpdir"), "claude-permission");
            debugLog("INIT", "Env CLAUDE_PERMISSION_DIR not set, using tmp dir: " + this.permissionDir);
        }
        debugLog("INIT", "Session ID: " + this.sessionId);
        try {
            Files.createDirectories(permissionDir);
            debugLog("INIT", "Permission directory created/verified: " + permissionDir);
        } catch (java.io.IOException e) {
            debugLog("INIT_ERROR", "Failed to create permission dir: " + e.getMessage());
            LOG.error("Error occurred", e);
        }

        this.decisionStore = new PermissionDecisionStore();
        this.dialogRouter = new PermissionDialogRouter((tag, message) -> debugLog(tag, message));
        this.fileProtocol = new PermissionFileProtocol(permissionDir, sessionId, gson, (tag, message) -> debugLog(tag, message));
        this.requestWatcher = new PermissionRequestWatcher(
                permissionDir, sessionId, fileProtocol, (tag, message) -> debugLog(tag, message));
    }

    public String getSessionId() { return this.sessionId; }

    public static synchronized PermissionService getInstance(Project project, String sessionId) {
        return PermissionSessionRegistry.getInstance(
                sessionId,
                () -> new PermissionService(project, PermissionSessionRegistry.newLegacySessionId()),
                sid -> new PermissionService(project, sid));
    }

    public static synchronized void removeInstance(String sessionId) {
        PermissionSessionRegistry.removeInstance(sessionId);
    }

    @Deprecated(since = "0.1.6", forRemoval = true)
    public static synchronized PermissionService getInstance(Project project) {
        return PermissionSessionRegistry.getLegacyInstance(
                () -> new PermissionService(project, PermissionSessionRegistry.newLegacySessionId()));
    }

    // ── Public API ─────────────────────────────────────────────────────

    public void setDecisionListener(PermissionDecisionListener listener) {
        this.decisionListener = listener;
        debugLog("CONFIG", "Decision listener set: " + (listener != null));
    }

    public void registerDialogShower(Project project, PermissionDialogShower shower) {
        dialogRouter.registerPermissionDialogShower(project, shower);
    }

    public void unregisterDialogShower(Project project) {
        dialogRouter.unregisterPermissionDialogShower(project);
    }

    public void registerAskUserQuestionDialogShower(Project project, AskUserQuestionDialogShower shower) {
        dialogRouter.registerAskUserQuestionDialogShower(project, shower);
    }

    public void unregisterAskUserQuestionDialogShower(Project project) {
        dialogRouter.unregisterAskUserQuestionDialogShower(project);
    }

    public void registerPlanApprovalDialogShower(Project project, PlanApprovalDialogShower shower) {
        dialogRouter.registerPlanApprovalDialogShower(project, shower);
    }

    public void unregisterPlanApprovalDialogShower(Project project) {
        dialogRouter.unregisterPlanApprovalDialogShower(project);
    }

    public void setLastActiveProject(Project project) {
        dialogRouter.setLastActiveProject(project);
    }

    @Deprecated
    public void setDialogShower(PermissionDialogShower shower) {
        if (shower != null && this.project != null) {
            dialogRouter.registerPermissionDialogShower(this.project, shower);
        }
        debugLog("CONFIG", "Dialog shower set (legacy): " + (shower != null));
    }

    public void clearDecisionMemory() {
        int paramSize = decisionStore.getParameterMemorySize();
        int toolSize = decisionStore.getToolMemorySize();
        decisionStore.clear();
        debugLog("MEMORY_CLEAR", "Cleared: param=" + paramSize + ", tool=" + toolSize + ", session=" + sessionId);
    }

    public void start() {
        this.lastActivityTime = System.currentTimeMillis();
        this.watcherHandler = new PermissionRequestWatcher.RequestHandler() {
            @Override
            public void handlePermissionRequest(Path requestFile) {
                PermissionService.this.handlePermissionRequest(requestFile);
            }

            @Override
            public void handleAskUserQuestionRequest(Path requestFile) {
                PermissionService.this.handleAskUserQuestionRequest(requestFile);
            }

            @Override
            public void handlePlanApprovalRequest(Path requestFile) {
                PermissionService.this.handlePlanApprovalRequest(requestFile);
            }
        };
        this.started = true;
        if (!daemonChannelActive) {
            requestWatcher.start(watcherHandler);
        }
    }

    public void stop() {
        this.started = false;
        requestWatcher.stop();
        daemonRequestExecutor.shutdownNow();
    }

    /**
     * Toggle daemon-channel mode. While active, the file watcher is stopped
     * (permission prompts arrive as daemon permission_request envelopes);
     * when the daemon dies, the watcher is reactivated so the per-process
     * fallback keeps working.
     */
    public synchronized void setDaemonChannelActive(boolean active) {
        if (this.daemonChannelActive == active) {
            return;
        }
        this.daemonChannelActive = active;
        debugLog("DAEMON_CHANNEL", "Daemon permission channel active: " + active);
        if (active) {
            requestWatcher.stop();
        } else {
            ensureWatcherStarted();
        }
    }

    /**
     * Start the file watcher if this service was started and the watcher is
     * not running (it may have been stopped while the daemon channel was
     * active). Idempotent; the watcher itself ignores duplicate starts.
     */
    synchronized void ensureWatcherStarted() {
        PermissionRequestWatcher.RequestHandler handler = this.watcherHandler;
        if (started && handler != null) {
            requestWatcher.start(handler);
        }
    }

    /**
     * Called by the per-process spawn path (EnvironmentConfigurator) whenever
     * a short-lived Node process is prepared: such a process can ONLY reach
     * the permission dialogs through the file protocol, so the watcher for
     * its session must be running. Lookup-only — never creates an instance.
     */
    public static void ensureFileWatcherForSession(String sessionId) {
        PermissionService service = PermissionSessionRegistry.findInstance(sessionId);
        if (service != null) {
            service.ensureWatcherStarted();
        }
    }

    long getLastActivityTime() {
        return lastActivityTime;
    }

    // ── Common Helpers ─────────────────────────────────────────────────

    /**
     * Acquire exclusive processing of a request file and read its content.
     * Handles deduplication, file readiness wait, and content reading.
     *
     * @return the file content, or null if the file should be skipped
     */
    private String acquireRequestContent(Path requestFile, String logTag) {
        String fileName = requestFile.getFileName().toString();
        if (!processingRequests.add(fileName)) {
            debugLog(logTag, "Already being processed, skipping: " + fileName);
            return null;
        }
        if (!fileProtocol.waitForFileReady(requestFile)) {
            debugLog(logTag, "File not ready: " + fileName);
            processingRequests.remove(fileName);
            return null;
        }
        try {
            return Files.readString(requestFile);
        } catch (NoSuchFileException e) {
            debugLog(logTag, "File missing while reading: " + fileName);
            processingRequests.remove(fileName);
            return null;
        } catch (java.io.IOException e) {
            debugLog(logTag, "Error reading file: " + e.getMessage());
            LOG.error("Error occurred", e);
            processingRequests.remove(fileName);
            return null;
        }
    }

    private void safeDeleteFile(Path file, String logTag) {
        try {
            Files.deleteIfExists(file);
            debugLog(logTag, "Deleted: " + file.getFileName());
        } catch (Exception e) {
            debugLog(logTag, "Failed to delete: " + e.getMessage());
        }
    }

    /**
     * Resolve a PermissionResponse from an integer value, defaulting to DENY.
     */
    private PermissionResponse resolveDecision(int responseValue) {
        PermissionResponse decision = PermissionResponse.fromValue(responseValue);
        if (decision == null) {
            LOG.warn("Response value " + responseValue + " mapped to null, defaulting to DENY");
            return PermissionResponse.DENY;
        }
        return decision;
    }

    private void notifyDecision(String toolName, JsonObject inputs, PermissionResponse response) {
        PermissionDecisionListener listener = this.decisionListener;
        if (listener == null || response == null) {
            return;
        }
        try {
            listener.onDecision(new PermissionDecision(toolName, inputs, response));
        } catch (Exception e) {
            LOG.error("Error occurred", e);
        }
    }

    // ── Permission Request Handling ────────────────────────────────────

    /**
     * Per-request context: how the request arrived (file vs daemon channel)
     * and how the decision gets back to the Node process.
     */
    private static class RequestContext {
        final String dedupKey;
        final PermissionResponseChannel channel;
        final Runnable deleteRequest;

        RequestContext(String dedupKey, PermissionResponseChannel channel, Runnable deleteRequest) {
            this.dedupKey = dedupKey;
            this.channel = channel;
            this.deleteRequest = deleteRequest;
        }
    }

    /**
     * Entry point for daemon-sourced permission prompts. Called from the
     * DaemonBridge reader thread; actual handling is offloaded to
     * {@link #daemonRequestExecutor} so a blocking fallback dialog can never
     * stall daemon stdout processing.
     *
     * @param envelope       the raw {"type":"permission_request",requestId,payload} envelope
     * @param responseSender sends the permission_response envelope to the daemon's stdin
     */
    public void handleDaemonPermissionRequest(JsonObject envelope, Consumer<JsonObject> responseSender) {
        this.lastActivityTime = System.currentTimeMillis();

        String requestId = envelope != null && envelope.has("requestId") && !envelope.get("requestId").isJsonNull()
                ? envelope.get("requestId").getAsString() : null;
        if (requestId == null || requestId.isEmpty()) {
            debugLog("DAEMON_INVALID", "Daemon permission request without requestId, dropping");
            return;
        }

        DaemonPermissionResponseChannel channel = new DaemonPermissionResponseChannel(requestId, responseSender);
        JsonObject request = buildDaemonRequest(envelope);
        if (request == null) {
            // Malformed payload: explicit deny — the Node side maps every
            // non-allow decision shape to deny for all three request kinds.
            debugLog("DAEMON_INVALID", "Malformed daemon permission request, denying: " + requestId);
            channel.writePermissionResponse(requestId, false);
            return;
        }

        String dedupKey = "daemon-" + requestId;
        if (!processingRequests.add(dedupKey)) {
            debugLog("DAEMON_DUP", "Duplicate daemon permission request, skipping: " + requestId);
            return;
        }

        String kind = request.get("__kind").getAsString();
        request.remove("__kind");
        RequestContext ctx = new RequestContext(dedupKey, channel, () -> { });
        daemonRequestExecutor.submit(() -> {
            try {
                switch (kind) {
                    case "tool":
                        processPermissionRequest(request, ctx);
                        break;
                    case "ask_user_question":
                        processAskUserQuestionRequest(request, ctx);
                        break;
                    case "plan_approval":
                        processPlanApprovalRequest(request, ctx);
                        break;
                    default:
                        // buildDaemonRequest only emits the three kinds above.
                        channel.writePermissionResponse(requestId, false);
                        processingRequests.remove(dedupKey);
                }
            } catch (Exception e) {
                debugLog("DAEMON_HANDLE_ERROR", "Error handling daemon request: " + e.getMessage());
                LOG.error("Error occurred", e);
                channel.writePermissionResponse(requestId, false);
                processingRequests.remove(dedupKey);
            }
        });
    }

    /**
     * Translate a daemon permission_request envelope into the request shape
     * the file protocol produces, so both transports share the downstream
     * memory/diff-review/dialog logic. Returns null when the payload is
     * malformed (caller denies). The internal "__kind" marker carries the
     * request kind for dispatch and is stripped before handling.
     */
    static JsonObject buildDaemonRequest(JsonObject envelope) {
        try {
            if (envelope == null || !envelope.has("payload") || !envelope.get("payload").isJsonObject()) {
                return null;
            }
            JsonObject payload = envelope.getAsJsonObject("payload");
            if (!payload.has("kind") || payload.get("kind").isJsonNull()) {
                return null;
            }
            String kind = payload.get("kind").getAsString();
            String requestId = envelope.get("requestId").getAsString();

            JsonObject request = new JsonObject();
            request.addProperty("requestId", requestId);
            request.addProperty("__kind", kind);
            if (payload.has("cwd") && !payload.get("cwd").isJsonNull()) {
                request.addProperty("cwd", payload.get("cwd").getAsString());
            }

            switch (kind) {
                case "tool":
                    if (!payload.has("toolName") || payload.get("toolName").isJsonNull()) {
                        return null;
                    }
                    request.addProperty("toolName", payload.get("toolName").getAsString());
                    request.add("inputs", payload.has("input") && payload.get("input").isJsonObject()
                            ? payload.getAsJsonObject("input") : new JsonObject());
                    return request;
                case "ask_user_question":
                    request.addProperty("toolName", "AskUserQuestion");
                    if (payload.has("questions")) {
                        request.add("questions", payload.get("questions"));
                    }
                    return request;
                case "plan_approval":
                    request.addProperty("toolName", "ExitPlanMode");
                    if (payload.has("plan") && !payload.get("plan").isJsonNull()) {
                        request.addProperty("plan", payload.get("plan").getAsString());
                    }
                    if (payload.has("allowedPrompts")) {
                        request.add("allowedPrompts", payload.get("allowedPrompts"));
                    }
                    return request;
                default:
                    return null;
            }
        } catch (Exception e) {
            return null;
        }
    }

    private void handlePermissionRequest(Path requestFile) {
        String fileName = requestFile.getFileName().toString();

        String content = acquireRequestContent(requestFile, "PERM");
        if (content == null) { return; }

        try {
            JsonObject request = gson.fromJson(content, JsonObject.class);
            processPermissionRequest(request, new RequestContext(
                    fileName, fileProtocol, () -> safeDeleteFile(requestFile, "PERM")));
        } catch (Exception e) {
            debugLog("HANDLE_ERROR", "Error handling request: " + e.getMessage());
            LOG.error("Error occurred", e);
            processingRequests.remove(fileName);
        }
    }

    private void processPermissionRequest(JsonObject request, RequestContext ctx) {
        long startTime = System.currentTimeMillis();
        this.lastActivityTime = startTime;

        try {
            String requestId = request.get("requestId").getAsString();
            String toolName = request.get("toolName").getAsString();
            JsonObject inputs = request.get("inputs").getAsJsonObject();

            // Check tool-level permission memory
            PermissionResponse toolDecision = decisionStore.getToolDecision(toolName);
            if (toolDecision != null) {
                boolean allow = toolDecision.isAllow();
                debugLog("MEMORY_HIT", "Tool-level: " + toolName + " -> " + (allow ? "ALLOW" : "DENY"));
                ctx.channel.writePermissionResponse(requestId, allow);
                notifyDecision(toolName, inputs, toolDecision);
                ctx.deleteRequest.run();
                return;
            }

            // Diff review for file-modifying tools (Edit, Write)
            if (DiffReviewService.isFileModifyingTool(toolName)
                    && tryDiffReview(request, ctx, requestId, toolName, inputs)) {
                return;
            }

            // Check parameter-level permission memory
            PermissionResponse remembered = decisionStore.getParameterDecision(toolName, inputs);
            if (remembered != null) {
                boolean allow = remembered != PermissionResponse.DENY;
                debugLog("PARAM_MEMORY_HIT", toolName + " -> " + (allow ? "ALLOW" : "DENY"));
                ctx.channel.writePermissionResponse(requestId, allow);
                notifyDecision(toolName, inputs, remembered);
                ctx.deleteRequest.run();
                return;
            }

            // Route to frontend dialog or system dialog fallback
            PermissionDialogShower shower = dialogRouter.findPermissionDialogShower(request, "MATCH_PROJECT");
            if (shower != null) {
                ctx.deleteRequest.run();
                dispatchPermissionDialog(shower, requestId, toolName, inputs, ctx);
            } else {
                dispatchPermissionFallback(requestId, toolName, inputs, ctx);
            }
        } catch (Exception e) {
            debugLog("HANDLE_ERROR", "Error handling request: " + e.getMessage());
            LOG.error("Error occurred", e);
        } finally {
            processingRequests.remove(ctx.dedupKey);
        }
    }

    private void dispatchPermissionDialog(PermissionDialogShower shower, String requestId,
                                          String toolName, JsonObject inputs, RequestContext ctx) {
        processingRequests.add(ctx.dedupKey); // re-add: caller's finally will remove, but async needs it
        final long dialogStart = System.currentTimeMillis();

        CompletableFuture<Integer> future = shower.showPermissionDialog(toolName, inputs);
        future.thenAccept(response -> {
            LOG.info("[PERM_FUTURE] response=" + response + ", elapsed="
                    + (System.currentTimeMillis() - dialogStart) + "ms, tool=" + toolName);
            try {
                PermissionResponse decision = resolveDecision(response);
                boolean allow = decision.isAllow();
                if (decision == PermissionResponse.ALLOW_ALWAYS) {
                    decisionStore.rememberToolDecision(toolName, PermissionResponse.ALLOW_ALWAYS);
                }
                notifyDecision(toolName, inputs, decision);
                ctx.channel.writePermissionResponse(requestId, allow);
            } catch (Exception e) {
                LOG.error("[PERM_FUTURE] Error: " + e.getMessage(), e);
            } finally {
                processingRequests.remove(ctx.dedupKey);
            }
        }).exceptionally(ex -> {
            LOG.error("[PERM_FUTURE] Exception: " + ex.getMessage(), ex);
            ctx.channel.writePermissionResponse(requestId, false);
            notifyDecision(toolName, inputs, PermissionResponse.DENY);
            processingRequests.remove(ctx.dedupKey);
            return null;
        });
    }

    private void dispatchPermissionFallback(String requestId, String toolName,
                                            JsonObject inputs, RequestContext ctx) {
        debugLog("FALLBACK_DIALOG", "Using JOptionPane for: " + toolName);
        try {
            CompletableFuture<Integer> future = new CompletableFuture<>();
            ApplicationManager.getApplication().invokeLater(
                    () -> future.complete(showSystemPermissionDialog(toolName, inputs)));

            int response = future.get(30, TimeUnit.SECONDS);
            PermissionResponse decision = resolveDecision(response);
            boolean allow = decision.isAllow();
            if (decision == PermissionResponse.ALLOW_ALWAYS) {
                decisionStore.rememberParameterDecision(toolName, inputs, PermissionResponse.ALLOW_ALWAYS);
            }
            notifyDecision(toolName, inputs, decision);
            ctx.channel.writePermissionResponse(requestId, allow);
            ctx.deleteRequest.run();
        } catch (Exception e) {
            debugLog("FALLBACK_ERROR", "Error: " + e.getMessage());
            LOG.error("Error occurred", e);
        }
    }

    private int showSystemPermissionDialog(String toolName, JsonObject inputs) {
        StringBuilder message = new StringBuilder();
        message.append("Claude requests to perform the following action:\n\n");
        message.append("Tool: ").append(toolName).append("\n");
        if (inputs.has("file_path")) {
            message.append("File: ").append(inputs.get("file_path").getAsString()).append("\n");
        }
        if (inputs.has("command")) {
            message.append("Command: ").append(inputs.get("command").getAsString()).append("\n");
        }
        message.append("\nAllow this action?");

        Object[] options = {"Allow", "Deny"};
        int result = JOptionPane.showOptionDialog(null, message.toString(),
                "Permission Request - " + toolName, JOptionPane.DEFAULT_OPTION,
                JOptionPane.QUESTION_MESSAGE, null, options, options[0]);
        return result == 0 ? PermissionResponse.ALLOW.getValue() : PermissionResponse.DENY.getValue();
    }

    // ── AskUserQuestion Request Handling ───────────────────────────────

    private void handleAskUserQuestionRequest(Path requestFile) {
        String fileName = requestFile.getFileName().toString();

        String content = acquireRequestContent(requestFile, "ASK");
        if (content == null) { return; }

        // Delete immediately to prevent duplicate polling (polling interval is 500ms)
        safeDeleteFile(requestFile, "ASK");

        processAskUserQuestionRequest(content, fileName, new RequestContext(
                fileName, fileProtocol, () -> { }));
    }

    private void processAskUserQuestionRequest(String content, String fileName, RequestContext ctx) {
        JsonObject request;
        try {
            request = gson.fromJson(content, JsonObject.class);
        } catch (Exception e) {
            debugLog("ASK_PARSE_ERROR", "Failed to parse JSON: " + fileName);
            processingRequests.remove(fileName);
            return;
        }
        if (request == null) {
            debugLog("ASK_PARSE_ERROR", "Failed to parse JSON: " + fileName);
            processingRequests.remove(fileName);
            return;
        }
        processAskUserQuestionRequest(request, ctx);
    }

    private void processAskUserQuestionRequest(JsonObject request, RequestContext ctx) {
        String dedupKey = ctx.dedupKey;

        // Track whether ownership has been transferred to an async dialog future.
        // If the future is created successfully, its .thenAccept / .exceptionally
        // callbacks own the processingRequests cleanup. Otherwise, the finally
        // block below removes the entry so the Set cannot leak across a hundred
        // turns (which would silently block any future request that happens to
        // reuse the same generated filename — see issue #1360).
        boolean dialogFutureOwnsCleanup = false;

        try {
            if (!request.has("requestId") || request.get("requestId").isJsonNull()
                    || !request.has("toolName") || request.get("toolName").isJsonNull()) {
                debugLog("ASK_INVALID", "Missing required fields: " + dedupKey);
                return;
            }

            String requestId = request.get("requestId").getAsString();
            AskUserQuestionDialogShower shower = dialogRouter.findAskUserQuestionDialogShower(request);

            if (shower != null) {
                dispatchAskQuestionDialog(shower, requestId, request, ctx);
                dialogFutureOwnsCleanup = true;
            } else {
                debugLog("ASK_NO_DIALOG", "No dialog shower, denying");
                ctx.channel.writeAskUserQuestionResponse(requestId, new JsonObject());
            }
        } catch (Exception e) {
            debugLog("ASK_HANDLE_ERROR", "Unexpected error: " + e.getMessage());
            LOG.error("Error occurred", e);
        } finally {
            if (!dialogFutureOwnsCleanup) {
                processingRequests.remove(dedupKey);
            }
        }
    }

    private void dispatchAskQuestionDialog(AskUserQuestionDialogShower shower,
                                           String requestId, JsonObject questionsData, RequestContext ctx) {
        final long dialogStart = System.currentTimeMillis();
        CompletableFuture<JsonObject> future = shower.showAskUserQuestionDialog(requestId, questionsData);

        future.thenAccept(answers -> {
            debugLog("ASK_RESPONSE", "Got answers after " + (System.currentTimeMillis() - dialogStart) + "ms");
            try {
                ctx.channel.writeAskUserQuestionResponse(requestId, answers);
            } catch (Exception e) {
                LOG.error("Error occurred", e);
            } finally {
                processingRequests.remove(ctx.dedupKey);
            }
        }).exceptionally(ex -> {
            debugLog("ASK_EXCEPTION", "Dialog exception: " + ex.getMessage());
            ctx.channel.writeAskUserQuestionResponse(requestId, new JsonObject());
            processingRequests.remove(ctx.dedupKey);
            return null;
        });
    }

    // ── PlanApproval Request Handling ──────────────────────────────────

    private void handlePlanApprovalRequest(Path requestFile) {
        String fileName = requestFile.getFileName().toString();

        String content = acquireRequestContent(requestFile, "PLAN");
        if (content == null) { return; }

        // Delete immediately to prevent duplicate processing
        safeDeleteFile(requestFile, "PLAN");

        JsonObject request;
        try {
            request = gson.fromJson(content, JsonObject.class);
        } catch (Exception e) {
            debugLog("PLAN_ERROR", "Error: " + e.getMessage());
            LOG.error("Error occurred", e);
            processingRequests.remove(fileName);
            return;
        }
        processPlanApprovalRequest(request, new RequestContext(
                fileName, fileProtocol, () -> { }));
    }

    private void processPlanApprovalRequest(JsonObject request, RequestContext ctx) {
        String dedupKey = ctx.dedupKey;

        // See processAskUserQuestionRequest above for the rationale. The async
        // dispatch path moves cleanup responsibility to the future callbacks; all
        // other code paths must release the dedup entry in finally.
        boolean dialogFutureOwnsCleanup = false;

        try {
            String requestId = request.get("requestId").getAsString();

            PlanApprovalDialogShower shower = dialogRouter.findPlanApprovalDialogShower(request);
            if (shower != null) {
                dispatchPlanApprovalDialog(shower, requestId, request, ctx);
                dialogFutureOwnsCleanup = true;
            } else {
                debugLog("PLAN_NO_DIALOG", "No dialog shower, denying");
                ctx.channel.writePlanApprovalResponse(requestId, false, "default");
            }
        } catch (Exception e) {
            debugLog("PLAN_ERROR", "Error: " + e.getMessage());
            LOG.error("Error occurred", e);
        } finally {
            if (!dialogFutureOwnsCleanup) {
                processingRequests.remove(dedupKey);
            }
        }
    }

    private void dispatchPlanApprovalDialog(PlanApprovalDialogShower shower,
                                            String requestId, JsonObject request, RequestContext ctx) {
        final long dialogStart = System.currentTimeMillis();
        CompletableFuture<JsonObject> future = shower.showPlanApprovalDialog(requestId, request);

        future.thenAccept(response -> {
            debugLog("PLAN_RESPONSE", "Got response after " + (System.currentTimeMillis() - dialogStart) + "ms");
            try {
                boolean approved = response.has("approved") && response.get("approved").getAsBoolean();
                String targetMode = response.has("targetMode") ? response.get("targetMode").getAsString() : "default";
                ctx.channel.writePlanApprovalResponse(requestId, approved, targetMode);
            } catch (Exception e) {
                LOG.error("Error occurred", e);
                ctx.channel.writePlanApprovalResponse(requestId, false, "default");
            } finally {
                processingRequests.remove(ctx.dedupKey);
            }
        }).exceptionally(ex -> {
            debugLog("PLAN_EXCEPTION", "Dialog exception: " + ex.getMessage());
            ctx.channel.writePlanApprovalResponse(requestId, false, "default");
            processingRequests.remove(ctx.dedupKey);
            return null;
        });
    }

    // ── Diff Review ────────────────────────────────────────────────────

    private boolean tryDiffReview(JsonObject request, RequestContext ctx,
                                  String requestId, String toolName, JsonObject inputs) {
        LOG.info("[DIFF_REVIEW] File-modifying tool: " + toolName
                + ", showers=" + dialogRouter.getPermissionDialogCount());

        Project matched = waitForDialogRegistration(request);
        if (matched == null) {
            return false;
        }

        CompletableFuture<DiffReviewResult> reviewFuture =
                DiffReviewService.reviewFileChange(matched, toolName, inputs);
        if (reviewFuture == null) {
            LOG.info("[DIFF_REVIEW] Not available for " + toolName + ", falling back");
            return false;
        }

        ctx.deleteRequest.run();
        reviewFuture.thenAccept(result -> {
            handleDiffReviewResult(result, requestId, toolName, inputs, ctx.channel);
            processingRequests.remove(ctx.dedupKey);
        }).exceptionally(ex -> {
            LOG.error("Diff review failed", ex);
            ctx.channel.writePermissionResponse(requestId, false);
            notifyDecision(toolName, inputs, PermissionResponse.DENY);
            processingRequests.remove(ctx.dedupKey);
            return null;
        });

        return true;
    }

    private Project waitForDialogRegistration(JsonObject request) {
        Project matched = dialogRouter.findProjectByCwd(request);
        if (matched != null || dialogRouter.getPermissionDialogCount() > 0) {
            return matched;
        }

        long maxWaitMs = (long) DIALOG_SHOWER_POLL_INTERVAL_MS * DIALOG_SHOWER_POLL_MAX_ATTEMPTS;
        LOG.info("[DIFF_REVIEW] Waiting for dialog registration (max " + maxWaitMs + "ms)...");
        int waited = 0;
        try {
            for (int i = 0; i < DIALOG_SHOWER_POLL_MAX_ATTEMPTS
                    && dialogRouter.getPermissionDialogCount() == 0; i++) {
                Thread.sleep(DIALOG_SHOWER_POLL_INTERVAL_MS);
                waited += DIALOG_SHOWER_POLL_INTERVAL_MS;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        matched = dialogRouter.findProjectByCwd(request);
        LOG.info("[DIFF_REVIEW] Retry after " + waited + "ms: "
                + (matched != null ? matched.getName() : "null"));
        return matched;
    }

    private void handleDiffReviewResult(DiffReviewResult result, String requestId,
                                        String toolName, JsonObject inputs, PermissionResponseChannel channel) {
        try {
            if (result.isAccepted()) {
                if (result.isAlwaysAllow()) {
                    decisionStore.rememberToolDecision(toolName, PermissionResponse.ALLOW_ALWAYS);
                }
                channel.writePermissionResponse(requestId, true);
                notifyDecision(toolName, inputs,
                        result.isAlwaysAllow() ? PermissionResponse.ALLOW_ALWAYS : PermissionResponse.ALLOW);
            } else {
                channel.writePermissionResponse(requestId, false);
                notifyDecision(toolName, inputs, PermissionResponse.DENY);
            }
        } catch (Exception e) {
            LOG.error("Error processing diff review result", e);
            channel.writePermissionResponse(requestId, false);
            notifyDecision(toolName, inputs, PermissionResponse.DENY);
        }
    }
}
