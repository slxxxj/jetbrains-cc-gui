package com.codeaide.dependency;

import com.codeaide.bridge.NodeDetector;
import com.codeaide.provider.claude.ClaudeSDKBridge;
import com.codeaide.runtime.NodeRuntimeManager;
import com.codeaide.ui.toolwindow.ClaudeChatWindow;
import com.codeaide.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationAction;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.progress.Task;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Fully automatic SDK dependency lifecycle service.
 *
 * <p>Triggered once per project open (see
 * {@code com.codeaide.startup.SdkAutoInstallActivity}); the service itself is an
 * application-level singleton, so duplicate triggers from multiple project windows are
 * coalesced and the same SDK is never installed concurrently.
 *
 * <p>Behavior:
 * <ul>
 *   <li>First run: silently installs every missing {@link SdkDefinition} in the background
 *       using the pinned version. Progress is shown once in the status bar; success stays
 *       quiet, failure raises a single notification with a "Retry" action.</li>
 *   <li>Background update check: when all SDKs are installed and the last update check is
 *       older than {@link #UPDATE_CHECK_INTERVAL_MILLIS}, silently checks for updates and,
 *       when any are found, raises a single notification listing them (cc-switch style).
 *       The update is applied only when the user clicks the "Update now" action; check
 *       failures never notify the user.</li>
 * </ul>
 */
public final class SdkAutoInstallService {

    private static final Logger LOG = Logger.getInstance(SdkAutoInstallService.class);

    private static final String NOTIFICATION_GROUP_ID = "CodeAide Notifications";
    private static final String LAST_UPDATE_CHECK_KEY = "claude.code.sdk.auto.update.last.check";

    /** Interval between silent update checks (24h). */
    static final long UPDATE_CHECK_INTERVAL_MILLIS = TimeUnit.HOURS.toMillis(24);

    private static volatile SdkAutoInstallService instance;
    private static final Object LOCK = new Object();

    private final DependencyManager dependencyManager;
    /** Guards the whole ensure flow so multi-window startups cannot interleave installs. */
    private final AtomicBoolean runInProgress = new AtomicBoolean(false);
    /** Guards user-triggered update runs so duplicate notification clicks cannot interleave. */
    private final AtomicBoolean updateInProgress = new AtomicBoolean(false);

    private SdkAutoInstallService() {
        this.dependencyManager = new DependencyManager(NodeDetector.getInstance());
    }

    public static SdkAutoInstallService getInstance() {
        if (instance == null) {
            synchronized (LOCK) {
                if (instance == null) {
                    instance = new SdkAutoInstallService();
                }
            }
        }
        return instance;
    }

    // ==================== Pure decision logic (unit tested) ====================

    /**
     * Action to take for an SDK on startup.
     */
    public enum StartupAction {
        /** SDK is missing and must be installed. */
        INSTALL,
        /** SDK is present; nothing to do on the install path. */
        NONE
    }

    /**
     * Decides whether an SDK needs installation based on its installed state.
     */
    public static StartupAction decideStartupAction(boolean installed) {
        return installed ? StartupAction.NONE : StartupAction.INSTALL;
    }

    /**
     * 24h throttle for background update checks.
     *
     * @param lastCheckMillis timestamp of the previous check, or {@code <= 0} if never checked
     * @param nowMillis       current time
     * @return true when a new silent update check should run
     */
    public static boolean shouldCheckForUpdates(long lastCheckMillis, long nowMillis) {
        if (lastCheckMillis <= 0) {
            return true;
        }
        return nowMillis - lastCheckMillis >= UPDATE_CHECK_INTERVAL_MILLIS;
    }

    /**
     * Decides whether an update check result should be surfaced to the user as an
     * available update. Error results and "already up to date" results are never shown.
     */
    public static boolean shouldApplyUpdate(@Nullable UpdateInfo info) {
        return info != null && info.hasUpdate() && info.getErrorMessage() == null;
    }

    /**
     * Builds the one-line summary used in the update notification, e.g.
     * {@code "Claude Code SDK 0.2.58 → 0.2.88、Codex SDK 0.117.0 → 0.118.0"}.
     */
    static String buildUpdateSummary(List<UpdateInfo> updates) {
        List<String> items = new ArrayList<>();
        for (UpdateInfo info : updates) {
            items.add(info.getSdkName() + " " + info.getCurrentVersion()
                    + " → " + info.getLatestVersion());
        }
        return String.join("、", items);
    }

    /**
     * Restarts the Claude daemons of every chat window in the given project so the
     * next message lazily spawns a fresh daemon that loads the newly installed SDK.
     * This makes an SDK update take effect immediately (hot update — no IDE restart).
     * No-op when the project is null or a window has no running daemon.
     */
    public static void restartClaudeDaemonsForHotUpdate(@Nullable Project project) {
        if (project == null) {
            return;
        }
        try {
            Set<ClaudeChatWindow> windows = ClaudeSDKToolWindow.getAllChatWindowsForProject(project);
            for (ClaudeChatWindow window : windows) {
                try {
                    ClaudeSDKBridge bridge = window != null ? window.getClaudeSDKBridge() : null;
                    if (bridge != null) {
                        bridge.shutdownDaemon();
                    }
                } catch (Exception e) {
                    LOG.warn("[SdkAutoInstall] Failed to restart daemon for one window: " + e.getMessage());
                }
            }
            LOG.info("[SdkAutoInstall] Claude daemons restarted for hot SDK update (project="
                    + project.getName() + ")");
        } catch (Exception e) {
            LOG.warn("[SdkAutoInstall] Failed to enumerate chat windows for hot update: " + e.getMessage());
        }
    }

    // ==================== Orchestration ====================

    /**
     * Entry point called on project open (and by the failure notification's Retry action).
     * Coalesces concurrent triggers: while a run is active, further calls are no-ops.
     */
    public void ensureSdksReadyAsync(@Nullable Project project) {
        if (!runInProgress.compareAndSet(false, true)) {
            LOG.info("[SdkAutoInstall] A run is already in progress; skipping duplicate trigger");
            return;
        }

        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                // Best-effort: ensure the isolated plugin-managed Node runtime first.
                // It integrates with NodeDetector, so the npm-based install below then
                // picks up the managed runtime automatically. Best-effort only: on
                // failure we fall back to NodeDetector resolving a system/user Node.
                try {
                    NodeRuntimeManager.getInstance().ensureRuntime().exceptionally(ex -> {
                        LOG.warn("[SdkAutoInstall] Managed Node runtime unavailable, "
                                + "falling back to system Node: " + ex.getMessage());
                        return null;
                    }).join();
                } catch (Exception e) {
                    LOG.warn("[SdkAutoInstall] Node runtime ensure failed, continuing: " + e.getMessage());
                }
                List<SdkDefinition> missing = findMissingSdks();
                if (!missing.isEmpty()) {
                    installMissingWithProgress(project, missing);
                } else {
                    // Nothing to install: (maybe) run the silent update check, then release.
                    try {
                        maybeCheckForUpdates(project);
                    } finally {
                        runInProgress.set(false);
                    }
                }
            } catch (Exception e) {
                LOG.warn("[SdkAutoInstall] Startup SDK check failed: " + e.getMessage(), e);
                runInProgress.set(false);
            }
        });
    }

    private List<SdkDefinition> findMissingSdks() {
        List<SdkDefinition> missing = new ArrayList<>();
        for (SdkDefinition sdk : SdkDefinition.values()) {
            try {
                if (decideStartupAction(dependencyManager.isInstalled(sdk.getId())) == StartupAction.INSTALL) {
                    missing.add(sdk);
                }
            } catch (Exception e) {
                LOG.warn("[SdkAutoInstall] Failed to check install state of " + sdk.getId()
                        + ": " + e.getMessage());
            }
        }
        return missing;
    }

    /**
     * Installs the missing SDKs sequentially in a cancellable-free background task
     * (npm install is not interruptible, so cancellation is disabled).
     */
    private void installMissingWithProgress(@Nullable Project project, List<SdkDefinition> missing) {
        ProgressManager.getInstance().run(new Task.Backgroundable(project, "Installing AI SDK dependencies", false) {
            private final List<String> failedNames = new ArrayList<>();

            @Override
            public void run(@NotNull ProgressIndicator indicator) {
                indicator.setIndeterminate(true);
                int total = missing.size();
                for (int i = 0; i < total; i++) {
                    SdkDefinition sdk = missing.get(i);
                    indicator.setText("Installing " + sdk.getDisplayName() + " (" + (i + 1) + "/" + total + ")...");
                    LOG.info("[SdkAutoInstall] Auto-installing " + sdk.getId() + " ...");
                    try {
                        InstallResult result = dependencyManager.installSdkSync(sdk.getId(),
                                line -> LOG.debug("[SdkAutoInstall] " + sdk.getId() + ": " + line));
                        if (result.isSuccess()) {
                            LOG.info("[SdkAutoInstall] Installed " + sdk.getId()
                                    + " version " + result.getInstalledVersion());
                        } else {
                            LOG.warn("[SdkAutoInstall] Install failed for " + sdk.getId()
                                    + ": " + result.getErrorMessage());
                            failedNames.add(sdk.getDisplayName());
                        }
                    } catch (Exception e) {
                        LOG.warn("[SdkAutoInstall] Install failed for " + sdk.getId()
                                + ": " + e.getMessage(), e);
                        failedNames.add(sdk.getDisplayName());
                    }
                }
            }

            @Override
            public void onFinished() {
                // Release the guard only when the whole flow is done, so a second project
                // window opening mid-install cannot start a duplicate install.
                runInProgress.set(false);
                if (!failedNames.isEmpty()) {
                    notifyInstallFailure(getProject(), new ArrayList<>(failedNames));
                }
            }
        });
    }

    /**
     * Raises a single non-modal notification offering a retry. Successful installs never
     * notify.
     */
    private void notifyInstallFailure(@Nullable Project project, List<String> failedNames) {
        try {
            String content = "以下 AI SDK 组件自动安装失败："
                    + String.join("、", failedNames)
                    + "。插件功能可能不可用，请检查网络/Node.js 环境后重试。";
            Notification notification = NotificationGroupManager.getInstance()
                    .getNotificationGroup(NOTIFICATION_GROUP_ID)
                    .createNotification("SDK 依赖自动安装失败", content, NotificationType.WARNING);
            notification.addAction(NotificationAction.createSimpleExpiring("重试",
                    () -> ensureSdksReadyAsync(project)));
            notification.notify(project);
        } catch (Exception e) {
            LOG.warn("[SdkAutoInstall] Failed to raise install failure notification: " + e.getMessage());
        }
    }

    /**
     * Silent background update check, throttled to once per {@link #UPDATE_CHECK_INTERVAL_MILLIS}.
     * Check failures never notify the user; when updates are found, a single notification is
     * raised and the update is applied only after the user clicks the update action.
     */
    private void maybeCheckForUpdates(@Nullable Project project) {
        long now = System.currentTimeMillis();
        long lastCheck = readLastUpdateCheck();
        if (!shouldCheckForUpdates(lastCheck, now)) {
            LOG.info("[SdkAutoInstall] Skipping update check; last check was "
                    + (now - lastCheck) + "ms ago");
            return;
        }
        // Record before checking so a failed check does not retry on every startup.
        writeLastUpdateCheck(now);

        List<UpdateInfo> updates = new ArrayList<>();
        for (SdkDefinition sdk : SdkDefinition.values()) {
            try {
                if (!dependencyManager.isInstalled(sdk.getId())) {
                    continue;
                }
                UpdateInfo info = dependencyManager.checkForUpdates(sdk.getId());
                if (shouldApplyUpdate(info)) {
                    updates.add(info);
                }
            } catch (Exception e) {
                LOG.warn("[SdkAutoInstall] Update check failed for " + sdk.getId()
                        + ": " + e.getMessage());
            }
        }

        if (updates.isEmpty()) {
            LOG.info("[SdkAutoInstall] Update check completed; all SDKs are up to date");
            return;
        }
        notifyUpdateAvailable(project, updates);
    }

    /**
     * Raises a single notification listing the available updates. The update runs only when
     * the user clicks the "Update now" action (cc-switch style manual update).
     */
    private void notifyUpdateAvailable(@Nullable Project project, List<UpdateInfo> updates) {
        try {
            String content = "以下 AI SDK 组件有可用更新：" + buildUpdateSummary(updates) + "。";
            Notification notification = NotificationGroupManager.getInstance()
                    .getNotificationGroup(NOTIFICATION_GROUP_ID)
                    .createNotification("SDK 依赖有可用更新", content, NotificationType.INFORMATION);
            notification.addAction(NotificationAction.createSimpleExpiring("立即更新",
                    () -> applyUpdatesWithProgress(project, updates)));
            notification.notify(project);
        } catch (Exception e) {
            LOG.warn("[SdkAutoInstall] Failed to raise update notification: " + e.getMessage());
        }
    }

    /**
     * Applies the given updates sequentially in a background task (npm install is not
     * interruptible, so cancellation is disabled). A failed update keeps the previously
     * installed version.
     */
    private void applyUpdatesWithProgress(@Nullable Project project, List<UpdateInfo> updates) {
        if (!updateInProgress.compareAndSet(false, true)) {
            LOG.info("[SdkAutoInstall] An update run is already in progress; ignoring duplicate trigger");
            return;
        }
        ProgressManager.getInstance().run(new Task.Backgroundable(project, "Updating AI SDK dependencies", false) {
            private final List<UpdateInfo> failedUpdates = new ArrayList<>();
            private final AtomicBoolean claudeSdkUpdated = new AtomicBoolean(false);

            @Override
            public void run(@NotNull ProgressIndicator indicator) {
                indicator.setIndeterminate(true);
                int total = updates.size();
                for (int i = 0; i < total; i++) {
                    UpdateInfo info = updates.get(i);
                    indicator.setText("Updating " + info.getSdkName() + " (" + (i + 1) + "/" + total + ")...");
                    LOG.info("[SdkAutoInstall] Updating " + info.getSdkId() + " from "
                            + info.getCurrentVersion() + " to " + info.getLatestVersion());
                    try {
                        InstallResult result = dependencyManager.installSdkSync(info.getSdkId(),
                                info.getLatestVersion(),
                                line -> LOG.debug("[SdkAutoInstall] update " + info.getSdkId() + ": " + line));
                        if (result.isSuccess()) {
                            LOG.info("[SdkAutoInstall] Updated " + info.getSdkId()
                                    + " to " + result.getInstalledVersion());
                            if (SdkDefinition.CLAUDE_SDK.getId().equals(info.getSdkId())) {
                                claudeSdkUpdated.set(true);
                            }
                        } else {
                            LOG.warn("[SdkAutoInstall] Update failed for " + info.getSdkId()
                                    + ": " + result.getErrorMessage());
                            failedUpdates.add(info);
                        }
                    } catch (Exception e) {
                        LOG.warn("[SdkAutoInstall] Update failed for " + info.getSdkId()
                                + ": " + e.getMessage(), e);
                        failedUpdates.add(info);
                    }
                }
            }

            @Override
            public void onFinished() {
                updateInProgress.set(false);
                if (claudeSdkUpdated.get()) {
                    // Hot update: restart Claude daemons so the next message loads the new SDK.
                    restartClaudeDaemonsForHotUpdate(getProject());
                }
                if (failedUpdates.isEmpty()) {
                    notifyUpdateSuccess(getProject(), updates.size(), claudeSdkUpdated.get());
                } else {
                    notifyUpdateFailure(getProject(), new ArrayList<>(failedUpdates));
                }
            }
        });
    }

    /**
     * Raises a single non-modal notification when all requested updates completed.
     */
    private void notifyUpdateSuccess(@Nullable Project project, int updatedCount, boolean claudeSdkUpdated) {
        try {
            String content = "已成功更新 " + updatedCount + " 个 AI SDK 组件。"
                    + (claudeSdkUpdated ? "Claude 运行时已自动重载，无需重启 IDE。" : "");
            Notification notification = NotificationGroupManager.getInstance()
                    .getNotificationGroup(NOTIFICATION_GROUP_ID)
                    .createNotification("SDK 依赖更新完成", content, NotificationType.INFORMATION);
            notification.notify(project);
        } catch (Exception e) {
            LOG.warn("[SdkAutoInstall] Failed to raise update success notification: " + e.getMessage());
        }
    }

    /**
     * Raises a single non-modal notification offering a retry for the failed updates.
     * The previously installed versions are kept.
     */
    private void notifyUpdateFailure(@Nullable Project project, List<UpdateInfo> failedUpdates) {
        try {
            List<String> failedNames = new ArrayList<>();
            for (UpdateInfo info : failedUpdates) {
                failedNames.add(info.getSdkName());
            }
            String content = "以下 AI SDK 组件更新失败："
                    + String.join("、", failedNames)
                    + "。已保留旧版本，请检查网络/Node.js 环境后重试。";
            Notification notification = NotificationGroupManager.getInstance()
                    .getNotificationGroup(NOTIFICATION_GROUP_ID)
                    .createNotification("SDK 依赖更新失败", content, NotificationType.WARNING);
            notification.addAction(NotificationAction.createSimpleExpiring("重试",
                    () -> applyUpdatesWithProgress(project, failedUpdates)));
            notification.notify(project);
        } catch (Exception e) {
            LOG.warn("[SdkAutoInstall] Failed to raise update failure notification: " + e.getMessage());
        }
    }

    private static long readLastUpdateCheck() {
        try {
            return PropertiesComponent.getInstance().getLong(LAST_UPDATE_CHECK_KEY, 0L);
        } catch (Exception e) {
            return 0L;
        }
    }

    private static void writeLastUpdateCheck(long timestamp) {
        try {
            PropertiesComponent.getInstance().setValue(LAST_UPDATE_CHECK_KEY, String.valueOf(timestamp));
        } catch (Exception e) {
            LOG.warn("[SdkAutoInstall] Failed to persist update check timestamp: " + e.getMessage());
        }
    }
}
