package com.codeaide.handler;

import com.codeaide.handler.core.BaseMessageHandler;
import com.codeaide.handler.core.HandlerContext;

import com.codeaide.bridge.NodeDetector;
import com.codeaide.dependency.DependencyManager;
import com.codeaide.dependency.InstallResult;
import com.codeaide.dependency.SdkAutoInstallService;
import com.codeaide.dependency.SdkDefinition;
import com.codeaide.model.NodeDetectionResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.concurrent.CompletableFuture;

/**
 * SDK dependency status and manual update handler.
 *
 * <p>SDK installation runs automatically in the background, and updates are
 * checked automatically (throttled) and applied only after the user confirms via
 * the update notification
 * (see {@link com.codeaide.dependency.SdkAutoInstallService}). In addition to the
 * read-only status/environment queries, this handler serves the manual
 * "check for updates" / "update" actions surfaced in the webview (model selector
 * dropdown): {@code check_dependency_updates} reports per-SDK current/latest
 * versions, and {@code update_dependency} installs the latest registry version
 * of one SDK. The legacy interactive messages ({@code uninstall_dependency} /
 * {@code get_dependency_versions}) remain unsupported and are safely ignored by
 * the message dispatcher.
 */
public class DependencyHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(DependencyHandler.class);
    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";

    private static final String[] SUPPORTED_TYPES = {
        "get_dependency_status",      // Get all SDK statuses (read-only)
        "check_node_environment",     // Check Node.js environment
        "check_dependency_updates",   // Manually check all SDKs for available updates
        "update_dependency"           // Manually update one SDK to its latest registry version
    };

    private final DependencyManager dependencyManager;
    private final Gson gson;
    private final NodeDetector nodeDetector;
    private volatile CompletableFuture<Void> initFuture;
    private final Object initLock;
    /** Guards manual update runs so duplicate clicks cannot interleave npm installs. */
    private final java.util.concurrent.atomic.AtomicBoolean updateInProgress =
            new java.util.concurrent.atomic.AtomicBoolean(false);

    public DependencyHandler(HandlerContext context) {
        super(context);
        this.nodeDetector = NodeDetector.getInstance();
        this.dependencyManager = new DependencyManager(this.nodeDetector);
        this.gson = new Gson();
        this.initFuture = null;
        this.initLock = new Object();
    }

    /**
     * Get the configured Node.js path from settings.
     */
    private String getConfiguredNodePath() {
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String savedPath = props.getValue(NODE_PATH_PROPERTY_KEY);
            if (savedPath != null && !savedPath.trim().isEmpty()) {
                return savedPath.trim();
            }
        } catch (Exception e) {
            LOG.warn("[DependencyHandler] Failed to get configured Node.js path: " + e.getMessage());
        }
        return null;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        this.ensureInitializedAsync();

        switch (type) {
            case "get_dependency_status":
                this.handleGetStatus();
                return true;
            case "check_node_environment":
                this.handleCheckNodeEnvironment();
                return true;
            case "check_dependency_updates":
                this.handleCheckUpdates();
                return true;
            case "update_dependency":
                this.handleUpdateDependency(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Performs deferred Node.js cache warm-up for configured path.
     * The returned future can be chained on by callers that depend on initialization.
     * After the first call, subsequent invocations return the same (possibly completed) future.
     */
    private void ensureInitializedAsync() {
        if (this.initFuture != null) {
            return;
        }

        synchronized (this.initLock) {
            if (this.initFuture != null) {
                return;
            }
            this.initFuture = CompletableFuture.runAsync(() -> {
            try {
                String configuredNodePath = this.getConfiguredNodePath();
                if (configuredNodePath == null || configuredNodePath.isEmpty()) {
                    return;
                }

                NodeDetectionResult result = this.nodeDetector.verifyAndCacheNodePath(configuredNodePath);
                if (result.isFound()) {
                    LOG.info("[DependencyHandler] Using configured Node.js path: " +
                             configuredNodePath + " (" + result.getNodeVersion() + ")");
                } else {
                    LOG.warn("[DependencyHandler] Configured Node.js path is invalid: " + configuredNodePath);
                }
            } catch (Exception e) {
                LOG.warn("[DependencyHandler] Lazy initialization failed: " + e.getMessage(), e);
            }
            }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
                LOG.error("[DependencyHandler] Unexpected error in ensureInitializedAsync: " + ex.getMessage(), ex);
                return null;
            });
        }
    }

    /**
     * Get installation status of all SDKs.
     */
    private void handleGetStatus() {
        long startTime = System.currentTimeMillis();
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject status = this.dependencyManager.getAllSdkStatus();
                String statusJson = this.gson.toJson(status);

                ApplicationManager.getApplication().invokeLater(() ->
                    this.callJavaScript("window.updateDependencyStatus", this.escapeJs(statusJson))
                );
            } catch (Exception e) {
                LOG.error("[DependencyHandler] Failed to get dependency status: " + e.getMessage(), e);
                this.sendErrorResult("updateDependencyStatus", e.getMessage());
                this.sendShowError("获取依赖状态失败: " + e.getMessage());
            } finally {
                long elapsed = System.currentTimeMillis() - startTime;
                LOG.debug("[DependencyHandler] handleGetStatus completed in " + elapsed +
                          "ms on thread " + Thread.currentThread().getName());
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[DependencyHandler] Unexpected error in handleGetStatus: " + ex.getMessage(), ex);
            return null;
        });
    }

    /**
     * Check Node.js environment.
     * Prefers the configured Node.js path; falls back to auto-detection if not configured.
     */
    private void handleCheckNodeEnvironment() {
        long startTime = System.currentTimeMillis();
        CompletableFuture.runAsync(() -> {
            try {
                boolean available = false;
                String detectedPath = null;
                String detectedVersion = null;

                // Fast-path: use cached shared detection result with no process/file I/O.
                String cachedPath = this.nodeDetector.getCachedNodePath();
                String cachedVersion = this.nodeDetector.getCachedNodeVersion();
                if (cachedPath != null && cachedVersion != null) {
                    available = true;
                    detectedPath = cachedPath;
                    detectedVersion = cachedVersion;
                }

                // If cache miss, first check if there is a configured Node.js path.
                if (!available) {
                    String configuredPath = this.getConfiguredNodePath();
                    if (configuredPath != null && !configuredPath.isEmpty()) {
                        NodeDetectionResult verifyResult =
                            this.nodeDetector.verifyAndCacheNodePath(configuredPath);
                        if (verifyResult.isFound()) {
                            available = true;
                            detectedPath = verifyResult.getNodePath();
                            detectedVersion = verifyResult.getNodeVersion();
                            LOG.info("[DependencyHandler] Node.js found at configured path: " +
                                     configuredPath + " (" + detectedVersion + ")");
                        } else {
                            LOG.warn("[DependencyHandler] Configured Node.js path is invalid: " + configuredPath);
                        }
                    }
                }

                // If the configured path is invalid, try auto-detection
                if (!available) {
                    available = this.dependencyManager.checkNodeEnvironment();
                    if (available) {
                        detectedPath = this.nodeDetector.getCachedNodePath();
                        detectedVersion = this.nodeDetector.getCachedNodeVersion();
                    }
                }

                JsonObject result = new JsonObject();
                result.addProperty("available", available);
                if (detectedPath != null) {
                    result.addProperty("path", detectedPath);
                }
                if (detectedVersion != null) {
                    result.addProperty("version", detectedVersion);
                }

                this.sendNodeEnvironmentStatus(result);
            } catch (Exception e) {
                LOG.error("[DependencyHandler] Failed to check Node environment: " + e.getMessage(), e);
                JsonObject result = new JsonObject();
                result.addProperty("available", false);
                result.addProperty("error", e.getMessage());
                this.sendNodeEnvironmentStatus(result);
                this.sendShowError("检查 Node.js 环境失败: " + e.getMessage());
            } finally {
                long elapsed = System.currentTimeMillis() - startTime;
                LOG.debug("[DependencyHandler] handleCheckNodeEnvironment completed in " + elapsed +
                          "ms on thread " + Thread.currentThread().getName());
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[DependencyHandler] Unexpected error in handleCheckNodeEnvironment: " + ex.getMessage(), ex);
            return null;
        });
    }

    /**
     * Manually checks every SDK for available updates and reports per-SDK
     * current/latest versions to the webview. Uses the registry-only lookup
     * (no hardcoded fallback) so an unreachable registry is reported as a
     * check failure instead of a misleading "up to date".
     */
    private void handleCheckUpdates() {
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject result = new JsonObject();
                result.addProperty("success", true);
                JsonObject sdks = new JsonObject();
                for (SdkDefinition sdk : SdkDefinition.values()) {
                    JsonObject entry = new JsonObject();
                    entry.addProperty("sdkName", sdk.getDisplayName());
                    boolean installed = this.dependencyManager.isInstalled(sdk.getId());
                    entry.addProperty("installed", installed);
                    if (installed) {
                        String current = this.dependencyManager.getInstalledVersion(sdk.getId());
                        String latest = this.dependencyManager.getLatestVersionFromRegistry(sdk.getId());
                        if (current != null) {
                            entry.addProperty("currentVersion", current);
                        }
                        if (latest == null) {
                            entry.addProperty("error", "cannot_fetch_latest_version");
                        } else {
                            entry.addProperty("latestVersion", latest);
                            entry.addProperty("hasUpdate",
                                    current != null && DependencyManager.compareVersions(current, latest) < 0);
                        }
                    }
                    sdks.add(sdk.getId(), entry);
                }
                result.add("sdks", sdks);

                ApplicationManager.getApplication().invokeLater(() ->
                    this.callJavaScript("window.dependencyUpdateCheckResult", this.escapeJs(this.gson.toJson(result)))
                );
            } catch (Exception e) {
                LOG.error("[DependencyHandler] Failed to check dependency updates: " + e.getMessage(), e);
                this.sendErrorResult("dependencyUpdateCheckResult", e.getMessage());
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[DependencyHandler] Unexpected error in handleCheckUpdates: " + ex.getMessage(), ex);
            return null;
        });
    }

    /**
     * Manually updates one SDK to its latest registry version.
     * Expects a JSON payload like {@code {"sdkId": "claude-sdk"}}.
     */
    private void handleUpdateDependency(String content) {
        String sdkId = null;
        try {
            if (content != null && !content.trim().isEmpty()) {
                JsonObject payload = JsonParser.parseString(content).getAsJsonObject();
                if (payload.has("sdkId") && payload.get("sdkId").isJsonPrimitive()) {
                    sdkId = payload.get("sdkId").getAsString();
                }
            }
        } catch (Exception e) {
            LOG.warn("[DependencyHandler] Invalid update_dependency payload: " + content);
        }

        SdkDefinition sdk = sdkId != null ? SdkDefinition.fromId(sdkId) : null;
        if (sdk == null) {
            this.sendUpdateResult(sdkId, false, null, "Unknown SDK: " + sdkId);
            return;
        }
        if (!this.dependencyManager.isInstalled(sdk.getId())) {
            this.sendUpdateResult(sdk.getId(), false, null, "SDK not installed");
            return;
        }
        if (!this.updateInProgress.compareAndSet(false, true)) {
            this.sendUpdateResult(sdk.getId(), false, null, "Another update is already in progress");
            return;
        }

        final String finalSdkId = sdk.getId();
        CompletableFuture.runAsync(() -> {
            try {
                String latest = this.dependencyManager.getLatestVersionFromRegistry(finalSdkId);
                if (latest == null) {
                    this.sendUpdateResult(finalSdkId, false, null, "Cannot fetch latest version");
                    return;
                }
                LOG.info("[DependencyHandler] Manually updating " + finalSdkId + " to " + latest);
                InstallResult result = this.dependencyManager.installSdkSync(finalSdkId, latest,
                        line -> LOG.debug("[DependencyHandler] update " + finalSdkId + ": " + line));
                if (result.isSuccess()) {
                    if (SdkDefinition.CLAUDE_SDK.getId().equals(finalSdkId)) {
                        // Hot update: restart Claude daemons so the next message loads the
                        // new SDK; no IDE restart needed. Codex needs nothing (per-process).
                        SdkAutoInstallService.restartClaudeDaemonsForHotUpdate(this.context.getProject());
                    }
                    this.sendUpdateResult(finalSdkId, true, result.getInstalledVersion(), null);
                    // Refresh the read-only status so the settings panel reflects the new version.
                    this.handleGetStatus();
                } else {
                    this.sendUpdateResult(finalSdkId, false, null, result.getErrorMessage());
                }
            } catch (Exception e) {
                LOG.error("[DependencyHandler] Failed to update dependency: " + e.getMessage(), e);
                this.sendUpdateResult(finalSdkId, false, null, e.getMessage());
            } finally {
                this.updateInProgress.set(false);
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[DependencyHandler] Unexpected error in handleUpdateDependency: " + ex.getMessage(), ex);
            this.updateInProgress.set(false);
            return null;
        });
    }

    private void sendUpdateResult(String sdkId, boolean success, String version, String errorMessage) {
        JsonObject result = new JsonObject();
        result.addProperty("success", success);
        if (sdkId != null) {
            result.addProperty("sdkId", sdkId);
        }
        if (version != null) {
            result.addProperty("version", version);
        }
        if (errorMessage != null) {
            result.addProperty("error", errorMessage);
        }

        ApplicationManager.getApplication().invokeLater(() ->
            this.callJavaScript("window.dependencyUpdateResult", this.escapeJs(this.gson.toJson(result)))
        );
    }

    // ==================== Helper Methods ====================

    private void sendNodeEnvironmentStatus(JsonObject result) {
        ApplicationManager.getApplication().invokeLater(() ->
            this.callJavaScript("window.nodeEnvironmentStatus", this.escapeJs(this.gson.toJson(result)))
        );
    }

    private void sendShowError(String message) {
        ApplicationManager.getApplication().invokeLater(() ->
            this.callJavaScript("window.showError", this.escapeJs(message))
        );
    }

    private void sendErrorResult(String callback, String errorMessage) {
        JsonObject error = new JsonObject();
        error.addProperty("success", false);
        error.addProperty("error", errorMessage);

        ApplicationManager.getApplication().invokeLater(() ->
            this.callJavaScript("window." + callback, this.escapeJs(this.gson.toJson(error)))
        );
    }
}
