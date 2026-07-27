package com.codeaide.startup;

import com.codeaide.dependency.SdkAutoInstallService;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.ProjectActivity;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Triggers fully automatic SDK dependency management on project open:
 * silent first-run install of missing SDKs and a throttled (24h) silent
 * background update check. The heavy lifting lives in
 * {@link SdkAutoInstallService}, an application-level singleton that coalesces
 * triggers from multiple project windows.
 */
public class SdkAutoInstallActivity implements ProjectActivity {

    private static final Logger LOG = Logger.getInstance(SdkAutoInstallActivity.class);

    @Nullable
    @Override
    public Object execute(@NotNull Project project, @NotNull Continuation<? super Unit> continuation) {
        LOG.info("[SdkAutoInstallActivity] Scheduling SDK auto install/update for project: " + project.getName());
        SdkAutoInstallService.getInstance().ensureSdksReadyAsync(project);
        return Unit.INSTANCE;
    }
}
