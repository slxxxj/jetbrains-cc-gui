package com.codeaide.ui;

import org.cef.handler.CefLoadHandler;
import org.junit.Test;

import javax.swing.*;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for the watchdog's "alive but blank" and renderer-death
 * recovery branches.
 *
 * <p>The time-based decision logic is extracted into the pure static
 * {@link WebviewWatchdog#isFrontendReadyTimeout} and
 * {@link WebviewWatchdog#isRecoverableLoadError} so it can be tested without
 * a running JCEF browser. The recovery state machine itself is exercised
 * through the public entry points ({@code notifyRenderProcessTerminated},
 * {@code notifyLoadError}, {@code checkHealthOnTabSelected}) with a
 * never-showing panel, which mirrors a background tab: recovery is deferred
 * until the tab is selected.
 */
public class WebviewWatchdogTest {

    private static final long READY_TIMEOUT_MS = 30_000L;

    /** A watchdog whose panel is never showing (background-tab semantics). */
    private static final class Fixture {
        final List<String> reloadReasons = new ArrayList<>();
        final AtomicInteger recreateCount = new AtomicInteger();
        final WebviewWatchdog watchdog;

        Fixture() {
            this(false);
        }

        Fixture(boolean disposed) {
            // mainPanel.isShowing() is false for an unparented panel, so
            // recoveries are deferred until checkHealthOnTabSelected().
            watchdog = new WebviewWatchdog(
                    new JPanel(),
                    reason -> reloadReasons.add(reason),
                    () -> recreateCount.incrementAndGet(),
                    () -> disposed,
                    () -> false);
        }

        int totalRecoveries() {
            return reloadReasons.size() + recreateCount.get();
        }
    }

    // =========================================================================
    // isFrontendReadyTimeout — decision table
    // =========================================================================

    @Test
    public void readyTimeoutRequiresCompletedLoad() {
        // loadCompletedAtMs == 0 means no main-frame load has finished since the
        // last reset — the ready-timeout window has not even started.
        assertFalse(WebviewWatchdog.isFrontendReadyTimeout(0L, false, 1_000_000L, READY_TIMEOUT_MS));
    }

    @Test
    public void readyTimeoutSkipsWhenReadyAlreadyReceived() {
        long loadAt = 1_000_000L;
        assertFalse(WebviewWatchdog.isFrontendReadyTimeout(
                loadAt, true, loadAt + READY_TIMEOUT_MS + 1, READY_TIMEOUT_MS));
    }

    @Test
    public void readyTimeoutSkipsWithinGraceWindow() {
        // Slow machines must be allowed to finish loading — the timeout only
        // fires after the full grace window.
        long loadAt = 1_000_000L;
        assertFalse(WebviewWatchdog.isFrontendReadyTimeout(
                loadAt, false, loadAt + READY_TIMEOUT_MS - 1, READY_TIMEOUT_MS));
    }

    @Test
    public void readyTimeoutFiresAfterGraceWindowWithoutReady() {
        long loadAt = 1_000_000L;
        assertTrue(WebviewWatchdog.isFrontendReadyTimeout(
                loadAt, false, loadAt + READY_TIMEOUT_MS + 1, READY_TIMEOUT_MS));
    }

    // =========================================================================
    // isRecoverableLoadError — decision table
    // =========================================================================

    @Test
    public void subFrameLoadErrorIsNotRecoverable() {
        assertFalse(WebviewWatchdog.isRecoverableLoadError(
                false, CefLoadHandler.ErrorCode.ERR_FAILED.getCode()));
    }

    @Test
    public void abortedMainFrameLoadIsNotRecoverable() {
        // ERR_ABORTED fires whenever a reload interrupts the previous load —
        // a normal event, not a failure.
        assertFalse(WebviewWatchdog.isRecoverableLoadError(
                true, CefLoadHandler.ErrorCode.ERR_ABORTED.getCode()));
    }

    @Test
    public void mainFrameLoadFailureIsRecoverable() {
        assertTrue(WebviewWatchdog.isRecoverableLoadError(
                true, CefLoadHandler.ErrorCode.ERR_FAILED.getCode()));
    }

    // =========================================================================
    // Recovery state machine via the public entry points
    // =========================================================================

    @Test
    public void renderCrashOnHiddenTabIsDeferredUntilTabSelected() {
        Fixture f = new Fixture();

        f.watchdog.notifyRenderProcessTerminated("TS_PROCESS_CRASHED");
        assertEquals("background tab must not be recovered proactively",
                0, f.totalRecoveries());

        f.watchdog.checkHealthOnTabSelected();
        assertEquals("selecting the tab must pick up the owed crash recovery",
                1, f.reloadReasons.size());
        assertTrue(f.reloadReasons.get(0).contains("render_process_terminated"));
        assertEquals(0, f.recreateCount.get());
    }

    @Test
    public void cooldownPreventsRecoveryStorm() {
        Fixture f = new Fixture();

        f.watchdog.notifyRenderProcessTerminated("TS_PROCESS_CRASHED");
        f.watchdog.checkHealthOnTabSelected();
        assertEquals(1, f.totalRecoveries());

        // A second crash inside the 60s cooldown must be deferred, not executed.
        f.watchdog.notifyRenderProcessTerminated("TS_PROCESS_CRASHED");
        f.watchdog.checkHealthOnTabSelected();
        assertEquals("recovery inside the cooldown window must be deferred",
                1, f.totalRecoveries());
    }

    @Test
    public void abortedLoadErrorDoesNotTriggerRecovery() {
        Fixture f = new Fixture();

        f.watchdog.notifyLoadError(true, CefLoadHandler.ErrorCode.ERR_ABORTED.getCode(),
                "Aborted", "https://localhost/");
        f.watchdog.checkHealthOnTabSelected();
        assertEquals(0, f.totalRecoveries());
    }

    @Test
    public void subFrameLoadErrorDoesNotTriggerRecovery() {
        Fixture f = new Fixture();

        f.watchdog.notifyLoadError(false, CefLoadHandler.ErrorCode.ERR_FAILED.getCode(),
                "Failed", "https://localhost/frame");
        f.watchdog.checkHealthOnTabSelected();
        assertEquals(0, f.totalRecoveries());
    }

    @Test
    public void mainFrameLoadErrorTriggersRecoveryOnTabSelected() {
        Fixture f = new Fixture();

        f.watchdog.notifyLoadError(true, CefLoadHandler.ErrorCode.ERR_FAILED.getCode(),
                "Failed", "https://localhost/");
        f.watchdog.checkHealthOnTabSelected();
        assertEquals(1, f.reloadReasons.size());
        assertTrue(f.reloadReasons.get(0).contains("load_error"));
    }

    @Test
    public void readyReceivedPreventsReadyTimeoutRecovery() {
        Fixture f = new Fixture();

        f.watchdog.markLoadCompleted();
        f.watchdog.markFrontendReady();
        f.watchdog.checkHealthOnTabSelected();
        assertEquals(0, f.totalRecoveries());
    }

    @Test
    public void resetTimestampsClearsOwedCrashRecovery() {
        Fixture f = new Fixture();

        f.watchdog.notifyRenderProcessTerminated("TS_PROCESS_CRASHED");
        // A fresh page load starts (reload/recreate entry point) — the owed
        // recovery for the old page must not fire against the new one.
        f.watchdog.resetTimestamps();
        f.watchdog.checkHealthOnTabSelected();
        assertEquals(0, f.totalRecoveries());
    }

    @Test
    public void disposedWindowNeverRecovers() {
        Fixture f = new Fixture(true);

        f.watchdog.notifyRenderProcessTerminated("TS_PROCESS_CRASHED");
        f.watchdog.checkHealthOnTabSelected();
        assertEquals(0, f.totalRecoveries());
    }
}
