package com.codeaide.handler;

import com.codeaide.handler.core.BaseMessageHandler;
import com.codeaide.handler.core.HandlerContext;

import com.codeaide.bridge.NodeDetector;
import com.codeaide.dependency.DependencyManager;
import com.codeaide.model.NodeDetectionResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.concurrent.CompletableFuture;

/**
 * SDK dependency read-only status handler.
 *
 * <p>SDK installation and updates run fully automatically in the background
 * (see {@link com.codeaide.dependency.SdkAutoInstallService}); the frontend may
 * only query the (read-only) SDK status and the Node.js environment. The legacy interactive
 * messages ({@code install_dependency} / {@code uninstall_dependency} /
 * {@code update_dependency} / {@code check_dependency_updates} /
 * {@code get_dependency_versions}) are no longer supported here and are safely ignored by
 * the message dispatcher.
 */
public class DependencyHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(DependencyHandler.class);
    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";

    private static final String[] SUPPORTED_TYPES = {
        "get_dependency_status",      // Get all SDK statuses (read-only)
        "check_node_environment"      // Check Node.js environment
    };

    private final DependencyManager dependencyManager;
    private final Gson gson;
    private final NodeDetector nodeDetector;
    private volatile CompletableFuture<Void> initFuture;
    private final Object initLock;

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
