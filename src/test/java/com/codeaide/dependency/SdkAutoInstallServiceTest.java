package com.codeaide.dependency;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SdkAutoInstallServiceTest {

    private static final long HOUR_MILLIS = 60L * 60L * 1000L;

    // ==================== decideStartupAction ====================

    @Test
    public void shouldInstallWhenSdkIsMissing() {
        assertEquals(SdkAutoInstallService.StartupAction.INSTALL,
                SdkAutoInstallService.decideStartupAction(false));
    }

    @Test
    public void shouldDoNothingWhenSdkIsInstalled() {
        assertEquals(SdkAutoInstallService.StartupAction.NONE,
                SdkAutoInstallService.decideStartupAction(true));
    }

    // ==================== shouldCheckForUpdates (24h throttle) ====================

    @Test
    public void shouldCheckForUpdatesWhenNeverChecked() {
        long now = System.currentTimeMillis();
        assertTrue(SdkAutoInstallService.shouldCheckForUpdates(0L, now));
        assertTrue(SdkAutoInstallService.shouldCheckForUpdates(-1L, now));
    }

    @Test
    public void shouldNotCheckForUpdatesWithinInterval() {
        long now = System.currentTimeMillis();
        assertFalse(SdkAutoInstallService.shouldCheckForUpdates(now, now));
        assertFalse(SdkAutoInstallService.shouldCheckForUpdates(now - HOUR_MILLIS, now));
        assertFalse(SdkAutoInstallService.shouldCheckForUpdates(now - 23L * HOUR_MILLIS, now));
    }

    @Test
    public void shouldCheckForUpdatesAfterIntervalElapsed() {
        long now = System.currentTimeMillis();
        assertTrue(SdkAutoInstallService.shouldCheckForUpdates(
                now - SdkAutoInstallService.UPDATE_CHECK_INTERVAL_MILLIS, now));
        assertTrue(SdkAutoInstallService.shouldCheckForUpdates(now - 25L * HOUR_MILLIS, now));
    }

    @Test
    public void shouldNotCheckForUpdatesWhenLastCheckIsInFuture() {
        long now = System.currentTimeMillis();
        assertFalse(SdkAutoInstallService.shouldCheckForUpdates(now + HOUR_MILLIS, now));
    }

    // ==================== shouldApplyUpdate ====================

    @Test
    public void shouldApplyUpdateWhenNewVersionAvailable() {
        UpdateInfo info = UpdateInfo.updateAvailable(
                SdkDefinition.CLAUDE_SDK.getId(),
                SdkDefinition.CLAUDE_SDK.getDisplayName(),
                "0.2.58",
                "0.2.88");
        assertTrue(SdkAutoInstallService.shouldApplyUpdate(info));
    }

    @Test
    public void shouldNotApplyUpdateWhenUpToDate() {
        UpdateInfo info = UpdateInfo.noUpdate(
                SdkDefinition.CODEX_SDK.getId(),
                SdkDefinition.CODEX_SDK.getDisplayName(),
                "0.117.0");
        assertFalse(SdkAutoInstallService.shouldApplyUpdate(info));
    }

    @Test
    public void shouldNotApplyUpdateOnError() {
        UpdateInfo info = UpdateInfo.error(
                SdkDefinition.CODEX_SDK.getId(),
                SdkDefinition.CODEX_SDK.getDisplayName(),
                "Cannot fetch latest version");
        assertFalse(SdkAutoInstallService.shouldApplyUpdate(info));
    }

    @Test
    public void shouldNotApplyUpdateForNullInfo() {
        assertFalse(SdkAutoInstallService.shouldApplyUpdate(null));
    }
}
