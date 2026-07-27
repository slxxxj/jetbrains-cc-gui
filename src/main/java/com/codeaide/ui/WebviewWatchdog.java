package com.codeaide.ui;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;
import org.cef.handler.CefLoadHandler;

import javax.swing.*;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * Webview render watchdog for JCEF stall/black-screen recovery.
 * Monitors heartbeat signals from the webview and triggers reload or recreate
 * when the webview becomes unresponsive.
 *
 * <p>Three failure modes are covered:
 * <ul>
 *   <li><b>Stall</b> — heartbeat/rAF stop for too long (the original case).</li>
 *   <li><b>Alive but blank</b> — the page loaded but {@code frontend_ready}
 *       never arrived within {@link #FRONTEND_READY_TIMEOUT_MS}. The heartbeat
 *       runs independently of React, so a React/i18n init crash or a hung
 *       startup leaves heartbeats flowing while the tab stays blank forever.
 *       Load completion is signalled via {@link #markLoadCompleted()} from the
 *       JCEF load handler; readiness via {@link #markFrontendReady()}.</li>
 *   <li><b>Renderer death</b> — render-process termination or a main-frame
 *       load error is reported by JCEF immediately ({@link
 *       #notifyRenderProcessTerminated} / {@link #notifyLoadError}) instead of
 *       waiting for the heartbeat timeout.</li>
 * </ul>
 *
 * <p>Background-tab gating: checks only run while the panel is showing (a
 * hidden tab's rAF/timers are throttled, which would produce false stalls),
 * and recoveries are not initiated for hidden tabs. The crash and
 * ready-timeout states are sticky, so when the tab is selected again
 * {@link #checkHealthOnTabSelected()} (hooked to the content-manager
 * selection listener) picks them up immediately.
 */
public class WebviewWatchdog {

    private static final Logger LOG = Logger.getInstance(WebviewWatchdog.class);

    private static final long HEARTBEAT_TIMEOUT_MS = 45_000L;
    private static final long WATCHDOG_INTERVAL_MS = 10_000L;
    private static final long RECOVERY_COOLDOWN_MS = 60_000L;

    // "Alive but blank": main-frame load finished but frontend_ready never
    // arrived. Generous on purpose — slow machines must finish first; only a
    // genuinely dead startup (React/i18n crash, bridge never injected) trips it.
    private static final long FRONTEND_READY_TIMEOUT_MS = 30_000L;

    private volatile long lastHeartbeatAtMs = System.currentTimeMillis();
    private volatile long lastRafAtMs = System.currentTimeMillis();
    private volatile String lastVisibility = null;
    private volatile Boolean lastHasFocus = null;
    private volatile int stallCount = 0;
    private volatile long lastRecoveryAtMs = 0L;
    private volatile ScheduledFuture<?> watchdogFuture = null;

    // Ready-timeout tracking ("alive but blank"). loadCompletedAtMs == 0 means
    // no main-frame load has completed since the last reset.
    private volatile long loadCompletedAtMs = 0L;
    private volatile boolean frontendReadyReceived = false;
    // Set when the renderer died (render-process termination or main-frame load
    // error) and a recovery is still owed. Kept as sticky state (not
    // fire-and-forget) so a recovery deferred by the cooldown or by
    // background-tab gating is not lost.
    private volatile String pendingCrashRecoveryReason = null;

    private final JPanel mainPanel;
    private final Consumer<String> onReloadWebview;
    private final Runnable onRecreateWebview;
    private final DisposedCheck disposedCheck;
    private final StreamActiveCheck streamActiveCheck;

    /**
     * Checks if the parent component has been disposed.
     */
    public interface DisposedCheck {
        boolean isDisposed();
    }

    /**
     * Checks if the backend is currently streaming.
     * During active streaming, JCEF IPC saturation is expected and reloading
     * the webview would destroy React state while the backend continues working.
     */
    public interface StreamActiveCheck {
        boolean isStreamActive();
    }

    // Extended timeout during active streaming — IPC saturation is expected
    // when pushing large message payloads.  Reloading would destroy React state
    // and the backend would continue pushing to a blank page.
    private static final long STREAMING_HEARTBEAT_TIMEOUT_MS = 180_000L; // 3 minutes

    /**
     * @param onReloadWebview soft recovery: reloads the HTML into the existing
     *     browser (with per-tab state re-injected). Accepts a reason string.
     * @param onRecreateWebview hard recovery: disposes and recreates the browser.
     */
    public WebviewWatchdog(
            JPanel mainPanel,
            Consumer<String> onReloadWebview,
            Runnable onRecreateWebview,
            DisposedCheck disposedCheck,
            StreamActiveCheck streamActiveCheck
    ) {
        this.mainPanel = mainPanel;
        this.onReloadWebview = onReloadWebview;
        this.onRecreateWebview = onRecreateWebview;
        this.disposedCheck = disposedCheck;
        this.streamActiveCheck = streamActiveCheck;
    }

    /**
     * Start the watchdog scheduler.
     */
    public void start() {
        if (watchdogFuture != null) {
            return;
        }

        watchdogFuture = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(() -> {
            try {
                checkHealth();
            } catch (Exception e) {
                LOG.debug("[WebviewWatchdog] Unexpected error: " + e.getMessage(), e);
            }
        }, WATCHDOG_INTERVAL_MS, WATCHDOG_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    /**
     * Stop the watchdog scheduler.
     */
    public void stop() {
        if (watchdogFuture != null) {
            watchdogFuture.cancel(true);
            watchdogFuture = null;
        }
    }

    /**
     * Handle a heartbeat message from the webview.
     */
    public void handleHeartbeat(String content) {
        long now = System.currentTimeMillis();
        lastHeartbeatAtMs = now;

        if (content == null || content.isEmpty()) {
            lastRafAtMs = now;
            lastVisibility = null;
            lastHasFocus = null;
            return;
        }

        try {
            JsonObject json = new Gson().fromJson(content, JsonObject.class);
            if (json != null) {
                if (json.has("raf")) {
                    lastRafAtMs = json.get("raf").getAsLong();
                } else {
                    lastRafAtMs = now;
                }
                if (json.has("visibility")) {
                    lastVisibility = json.get("visibility").getAsString();
                }
                if (json.has("focus")) {
                    lastHasFocus = json.get("focus").getAsBoolean();
                }
            }
        } catch (Exception ignored) {
            // Non-JSON heartbeat payload (backward compatibility)
            lastRafAtMs = now;
        }
    }

    /**
     * Reset heartbeat timestamps and recovery tracking (a fresh page load is
     * starting — called on initial load and on every watchdog reload/recreate).
     */
    public void resetTimestamps() {
        long now = System.currentTimeMillis();
        lastHeartbeatAtMs = now;
        lastRafAtMs = now;
        loadCompletedAtMs = 0L;
        frontendReadyReceived = false;
        pendingCrashRecoveryReason = null;
    }

    /**
     * Called from the JCEF load handler when the main frame finishes loading.
     * Starts the "alive but blank" detection window: if no
     * {@link #markFrontendReady()} follows within the timeout, the page is
     * treated as blank despite live heartbeats.
     */
    public void markLoadCompleted() {
        loadCompletedAtMs = System.currentTimeMillis();
        frontendReadyReceived = false;
    }

    /**
     * Called when the frontend sends its {@code frontend_ready} signal.
     */
    public void markFrontendReady() {
        frontendReadyReceived = true;
    }

    /**
     * Called from the JCEF request handler when the renderer process dies
     * (crash, kill, OOM). Triggers recovery immediately instead of waiting
     * for the heartbeat timeout — unless the tab is in the background, in
     * which case the sticky reason is picked up when the tab is selected.
     */
    public void notifyRenderProcessTerminated(String status) {
        pendingCrashRecoveryReason = "render_process_terminated(" + status + ")";
        LOG.warn("[WebviewWatchdog] Render process terminated: " + status);
        recoverNowIfShowing();
    }

    /**
     * Called from the JCEF load handler on a main-frame load error.
     * {@code ERR_ABORTED} (fired when a reload interrupts the previous load)
     * and sub-frame errors are ignored.
     */
    public void notifyLoadError(boolean mainFrame, int errorCode, String errorText, String failedUrl) {
        if (!isRecoverableLoadError(mainFrame, errorCode)) {
            return;
        }
        pendingCrashRecoveryReason = "load_error(code=" + errorCode + ", " + errorText + ", " + failedUrl + ")";
        LOG.warn("[WebviewWatchdog] Main-frame load error: code=" + errorCode
                + ", " + errorText + ", url=" + failedUrl);
        recoverNowIfShowing();
    }

    /**
     * Immediate health check for a tab that has just been selected. Skips the
     * {@code isShowing} gate (Swing may not have refreshed the showing state
     * yet at selection time) but deliberately does NOT run the heartbeat-stall
     * check: a background tab's rAF/timers are throttled, so its rafAge is
     * inflated right after selection and would produce a false stall. The
     * regular polling pass handles stalls once heartbeats catch up.
     */
    public void checkHealthOnTabSelected() {
        if (disposedCheck.isDisposed()) { return; }

        long now = System.currentTimeMillis();
        String crashReason = pendingCrashRecoveryReason;
        if (crashReason != null) {
            performRecovery(crashReason, true);
            return;
        }
        if (isFrontendReadyTimeout(loadCompletedAtMs, frontendReadyReceived, now, FRONTEND_READY_TIMEOUT_MS)) {
            performRecovery("frontend_ready_timeout_on_tab_selected", false);
        }
    }

    /**
     * Fire the owed crash recovery right away when the tab is visible.
     * Background tabs are left alone (the sticky reason survives until the
     * tab is selected or a polling pass sees the panel showing again).
     */
    private void recoverNowIfShowing() {
        if (disposedCheck.isDisposed()) { return; }
        if (!mainPanel.isShowing()) { return; }
        String reason = pendingCrashRecoveryReason;
        if (reason != null) {
            performRecovery(reason, true);
        }
    }

    private void checkHealth() {
        if (disposedCheck.isDisposed()) { return; }
        if (!mainPanel.isShowing()) { return; }

        long now = System.currentTimeMillis();

        // 1) Renderer death / main-frame load error: the page is dead, so the
        //    visibility/focus gates below are meaningless — recover at once.
        String crashReason = pendingCrashRecoveryReason;
        if (crashReason != null) {
            performRecovery(crashReason, true);
            return;
        }

        // 2) "Alive but blank": load finished but frontend_ready never arrived.
        //    Not subject to the visibility/focus gates — a React init crash
        //    leaves heartbeats flowing with a permanently blank page.
        if (isFrontendReadyTimeout(loadCompletedAtMs, frontendReadyReceived, now, FRONTEND_READY_TIMEOUT_MS)) {
            performRecovery("frontend_ready_timeout", false);
            return;
        }

        // 3) Heartbeat/rAF stall (original detection).
        long heartbeatAgeMs = now - lastHeartbeatAtMs;
        long rafAgeMs = now - lastRafAtMs;

        boolean visible = lastVisibility == null || "visible".equals(lastVisibility);
        boolean focused = lastHasFocus == null || lastHasFocus;
        if (!visible || !focused) {
            return;
        }

        // During active streaming, JCEF IPC saturation is expected with large payloads.
        // Use a much longer timeout to avoid destroying React state unnecessarily.
        // Reloading during streaming causes "fake death": backend continues working
        // but the webview shows empty content because streaming state is lost.
        boolean streaming = streamActiveCheck.isStreamActive();
        long effectiveTimeoutMs = streaming ? STREAMING_HEARTBEAT_TIMEOUT_MS : HEARTBEAT_TIMEOUT_MS;

        boolean stalled = heartbeatAgeMs > effectiveTimeoutMs || rafAgeMs > effectiveTimeoutMs;
        if (!stalled) {
            stallCount = 0;
            return;
        }

        performRecovery("heartbeat stall (heartbeatAgeMs=" + heartbeatAgeMs
                + ", rafAgeMs=" + rafAgeMs + ")", false);
    }

    /**
     * Shared recovery path for all failure modes: first offense reloads the
     * page, consecutive offenses recreate the browser. The cooldown only
     * defers the recovery — the triggering state (stall condition, sticky
     * crash reason, ready timeout) persists and is retried by the next pass,
     * so nothing is lost.
     */
    private void performRecovery(String reason, boolean crashRecovery) {
        long now = System.currentTimeMillis();
        if (now - lastRecoveryAtMs < RECOVERY_COOLDOWN_MS) {
            return;
        }
        if (disposedCheck.isDisposed()) { return; }

        stallCount += 1;
        LOG.warn("[WebviewWatchdog] Webview appears unhealthy (" + stallCount
                + "), attempting recovery. reason=" + reason);

        lastRecoveryAtMs = now;
        // Give the webview a grace window after initiating recovery to avoid repeated triggers.
        lastHeartbeatAtMs = now;
        lastRafAtMs = now;
        if (crashRecovery) {
            pendingCrashRecoveryReason = null; // consume the sticky reason
        } else {
            // Re-arm the ready-timeout window: the reload/recreate produces a
            // fresh onLoadEnd, and if frontend_ready still never comes the next
            // pass escalates to recreate. (resetTimestamps() from the reload
            // path clears these as well; do it here too so a failed reload
            // does not spin on a stale loadCompletedAtMs.)
            loadCompletedAtMs = 0L;
            frontendReadyReceived = false;
        }

        if (stallCount <= 1) {
            onReloadWebview.accept(reason);
        } else {
            onRecreateWebview.run();
            stallCount = 0;
        }
    }

    /**
     * Pure decision function for the "alive but blank" branch, extracted for
     * unit tests: the timeout fires only when a main-frame load has completed
     * ({@code loadCompletedAtMs > 0}), no {@code frontend_ready} has been
     * received since, and the grace window has elapsed.
     */
    static boolean isFrontendReadyTimeout(long loadCompletedAtMs, boolean readyReceived,
                                          long nowMs, long timeoutMs) {
        return loadCompletedAtMs > 0 && !readyReceived && (nowMs - loadCompletedAtMs) > timeoutMs;
    }

    /**
     * Pure decision function for load-error recovery, extracted for unit
     * tests: only main-frame errors count, and {@code ERR_ABORTED} is excluded
     * because it fires whenever a reload interrupts the previous load — a
     * normal event, not a failure.
     */
    static boolean isRecoverableLoadError(boolean mainFrame, int errorCode) {
        return mainFrame && errorCode != CefLoadHandler.ErrorCode.ERR_ABORTED.getCode();
    }
}
