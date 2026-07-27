package com.codeaide.handler.core;

import com.codeaide.session.ClaudeSession;
import com.codeaide.session.SessionProviderRouter;
import com.codeaide.provider.claude.ClaudeSDKBridge;
import com.codeaide.provider.codex.CodexSDKBridge;
import com.codeaide.provider.common.ProviderOps;
import com.codeaide.settings.CodeaideSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.ui.jcef.JBCefBrowser;

/**
 * Handler context.
 * Provides all shared resources and callbacks needed by handlers.
 */
public class HandlerContext {

    public static final String DEFAULT_MODEL = "claude-sonnet-4-6";
    public static final String DEFAULT_PROVIDER = "claude";

    private final Project project;
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final CodeaideSettingsService settingsService;
    private final JsCallback jsCallback;

    // Mutable state accessed via getters/setters — volatile for thread safety
    private volatile ClaudeSession session;
    private volatile JBCefBrowser browser;
    private volatile String currentModel = DEFAULT_MODEL;
    private volatile String currentProvider = DEFAULT_PROVIDER;
    private volatile boolean disposed = false;
    private volatile SessionProviderRouter providerRouter;

    /**
     * JavaScript callback interface.
     */
    public interface JsCallback {
        void callJavaScript(String functionName, String... args);
        String escapeJs(String str);
    }

    public HandlerContext(
            Project project,
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            CodeaideSettingsService settingsService,
            JsCallback jsCallback
    ) {
        this.project = project;
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
        this.settingsService = settingsService;
        this.jsCallback = jsCallback;
    }

    // Getters
    public Project getProject() {
        return project;
    }

    public ClaudeSDKBridge getClaudeSDKBridge() {
        return claudeSDKBridge;
    }

    public CodexSDKBridge getCodexSDKBridge() {
        return codexSDKBridge;
    }

    /**
     * Look up the operations for a provider via the session provider registry.
     * Unknown or null names fall back to the default (claude) provider.
     */
    public ProviderOps getProviderOps(String provider) {
        SessionProviderRouter router = providerRouter;
        if (router == null) {
            router = new SessionProviderRouter(claudeSDKBridge, codexSDKBridge);
            providerRouter = router;
        }
        return router.ops(provider);
    }

    public CodeaideSettingsService getSettingsService() {
        return settingsService;
    }

    /**
     * Resolve the normalized effective working directory for the current project —
     * the custom working directory when configured and valid, otherwise the project
     * base path. This is the directory Claude runs in and the key history is stored
     * under, so history readers must use this instead of the raw base path.
     *
     * <p>Null-safe: returns the raw base path when no settings service is wired.
     */
    public String resolveEffectiveWorkingDirectory() {
        String basePath = project != null ? project.getBasePath() : null;
        if (settingsService == null) {
            return basePath;
        }
        return settingsService.getEffectiveWorkingDirectory(basePath);
    }

    public ClaudeSession getSession() {
        return session;
    }

    public JBCefBrowser getBrowser() {
        return browser;
    }

    public String getCurrentModel() {
        return currentModel;
    }

    public String getCurrentProvider() {
        return currentProvider;
    }

    public boolean isDisposed() {
        return disposed;
    }

    // Setters
    public void setSession(ClaudeSession session) {
        this.session = session;
    }

    public void setBrowser(JBCefBrowser browser) {
        this.browser = browser;
    }

    public void setCurrentModel(String currentModel) {
        this.currentModel = currentModel;
    }

    public void setCurrentProvider(String currentProvider) {
        this.currentProvider = currentProvider;
    }

    public void setDisposed(boolean disposed) {
        this.disposed = disposed;
    }

    // JavaScript callback proxy methods
    public void callJavaScript(String functionName, String... args) {
        jsCallback.callJavaScript(functionName, args);
    }

    public String escapeJs(String str) {
        return jsCallback.escapeJs(str);
    }

    /**
     * Execute JavaScript on the EDT (Event Dispatch Thread).
     */
    public void executeJavaScriptOnEDT(String jsCode) {
        if (browser != null && !disposed) {
            ApplicationManager.getApplication().invokeLater(() -> {
                if (browser != null && !disposed) {
                    browser.getCefBrowser().executeJavaScript(jsCode, browser.getCefBrowser().getURL(), 0);
                }
            });
        }
    }
}
