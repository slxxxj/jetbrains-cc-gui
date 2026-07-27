package com.codeaide.handler;

import com.codeaide.bridge.NodeDetector;
import com.codeaide.handler.core.HandlerContext;
import com.codeaide.settings.CodeaideSettingsService;
import com.codeaide.util.PlatformUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link RecallHandler} covering parameter validation and WSL-aware
 * project path resolution.
 *
 * <p>The full rewind/truncate flow goes through static calls into
 * {@link com.codeaide.provider.claude.ClaudeSessionTruncateService} and the SDK bridge,
 * so it is out of scope for a plain unit test; truncation itself is covered by
 * {@code ClaudeSessionTruncateServiceTest}.
 *
 * <p>{@code sendResult} posts to the EDT via {@code ApplicationManager.getApplication()
 * .invokeLater(...)}, which is null without a booted IntelliJ platform. These tests
 * install a stand-in Application whose invokeLater runs the runnable inline, and capture
 * the {@code onRecallResult} payload through the context's {@link HandlerContext.JsCallback}.
 * {@code handle()} runs the work in a {@link java.util.concurrent.CompletableFuture},
 * so tests await the recorded callback instead of the future.
 */
public class RecallHandlerTest {

    private Application previousApplication;
    private RecordingJsCallback jsCallback;

    @Before
    public void setUp() {
        previousApplication = ApplicationManager.getApplication();
        ApplicationManager.setApplication(inlineInvokeLaterApplication());
        jsCallback = new RecordingJsCallback();
        NodeDetector.getInstance().clearCache();
    }

    @After
    public void tearDown() {
        ApplicationManager.setApplication(previousApplication);
        NodeDetector.getInstance().clearCache();
    }

    @Test
    public void supportedTypesContainRecallMessage() {
        RecallHandler handler = new RecallHandler(contextWith(null, null));
        assertArrayEquals(new String[]{"recall_message"}, handler.getSupportedTypes());
    }

    @Test
    public void handleReturnsFalseForUnknownType() {
        // The IPC bridge fans messages to every registered handler; returning false lets
        // the bridge try the next one.
        RecallHandler handler = new RecallHandler(contextWith(null, null));
        assertFalse(handler.handle("totally_unknown_type", "{}"));
    }

    @Test
    public void invalidSessionIdIsRejected() throws Exception {
        RecallHandler handler = new RecallHandler(contextWith(null, null));

        assertTrue(handler.handle("recall_message",
                "{\"sessionId\":\"../evil\",\"userMessageId\":\"u1\"}"));

        JsonObject result = awaitResult();
        assertFalse(result.get("success").getAsBoolean());
        assertEquals("Invalid session id", result.get("message").getAsString());
    }

    @Test
    public void blankUserMessageIdIsRejected() throws Exception {
        RecallHandler handler = new RecallHandler(contextWith(null, null));

        assertTrue(handler.handle("recall_message", "{\"sessionId\":\"abc-123\"}"));
        JsonObject missing = awaitResult();
        assertFalse(missing.get("success").getAsBoolean());
        assertEquals("User message id is required", missing.get("message").getAsString());

        assertTrue(handler.handle("recall_message",
                "{\"sessionId\":\"abc-123\",\"userMessageId\":\"\"}"));
        JsonObject empty = awaitResult();
        assertFalse(empty.get("success").getAsBoolean());
        assertEquals("User message id is required", empty.get("message").getAsString());
    }

    @Test
    public void unresolvableProjectPathIsReported() throws Exception {
        // No project and no settings service: the working directory cannot be resolved.
        RecallHandler handler = new RecallHandler(contextWith(null, null));

        assertTrue(handler.handle("recall_message",
                "{\"sessionId\":\"abc-123\",\"userMessageId\":\"u1\"}"));

        JsonObject result = awaitResult();
        assertFalse(result.get("success").getAsBoolean());
        assertEquals("Cannot resolve project path", result.get("message").getAsString());
    }

    @Test
    public void resolveProjectPathFallsBackToProjectBasePath() throws Exception {
        RecallHandler handler = new RecallHandler(contextWith(projectWithBasePath("D:/work/demo"), null));
        assertEquals("D:/work/demo", resolveProjectPath(handler));
    }

    @Test
    public void resolveProjectPathPrefersEffectiveWorkingDirectory() throws Exception {
        CodeaideSettingsService settingsService = new CodeaideSettingsService() {
            @Override
            public String getEffectiveWorkingDirectory(String projectPath) {
                return "D:/custom/dir";
            }
        };
        RecallHandler handler = new RecallHandler(
                contextWith(projectWithBasePath("D:/work/demo"), settingsService));
        assertEquals("D:/custom/dir", resolveProjectPath(handler));
    }

    @Test
    public void resolveProjectPathPassesThroughWhenNodeIsNative() throws Exception {
        NodeDetector.getInstance().setNodeExecutable("C:\\Program Files\\nodejs\\node.exe");
        RecallHandler handler = new RecallHandler(contextWith(projectWithBasePath("D:/work/demo"), null));
        assertEquals("D:/work/demo", resolveProjectPath(handler));
    }

    @Test
    public void resolveProjectPathConvertsToWslWhenNodeRunsInsideWsl() throws Exception {
        Assume.assumeTrue("WSL paths are only recognised on a Windows host",
                PlatformUtils.isWindows());
        NodeDetector.getInstance().setNodeExecutable("/usr/bin/node");

        RecallHandler handler = new RecallHandler(contextWith(projectWithBasePath("D:\\work\\demo"), null));

        assertEquals("/mnt/d/work/demo", resolveProjectPath(handler));
    }

    // --- helpers ---

    private JsonObject awaitResult() throws Exception {
        String[] call = jsCallback.calls.poll(5, TimeUnit.SECONDS);
        assertNotNull("onRecallResult was not invoked within 5s", call);
        assertEquals("onRecallResult", call[0]);
        return JsonParser.parseString(call[1]).getAsJsonObject();
    }

    private String resolveProjectPath(RecallHandler handler) throws Exception {
        Method method = RecallHandler.class.getDeclaredMethod("resolveProjectPath");
        method.setAccessible(true);
        return (String) method.invoke(handler);
    }

    private HandlerContext contextWith(Project project, CodeaideSettingsService settingsService) {
        return new HandlerContext(project, null, null, settingsService, jsCallback);
    }

    /** Stand-in Application whose invokeLater runs the runnable inline (no EDT exists in a unit test). */
    private static Application inlineInvokeLaterApplication() {
        return (Application) Proxy.newProxyInstance(
                Application.class.getClassLoader(),
                new Class[]{Application.class},
                (proxy, method, args) -> {
                    if ("invokeLater".equals(method.getName()) && args != null
                            && args.length > 0 && args[0] instanceof Runnable) {
                        ((Runnable) args[0]).run();
                        return null;
                    }
                    if ("toString".equals(method.getName())) {
                        return "RecallHandlerTest inline Application";
                    }
                    return defaultValue(method.getReturnType());
                }
        );
    }

    private static Project projectWithBasePath(String basePath) {
        return (Project) Proxy.newProxyInstance(
                Project.class.getClassLoader(),
                new Class[]{Project.class},
                (proxy, method, args) -> {
                    if ("getBasePath".equals(method.getName())) {
                        return basePath;
                    }
                    if ("toString".equals(method.getName())) {
                        return "RecallHandlerTest Project(" + basePath + ")";
                    }
                    return defaultValue(method.getReturnType());
                }
        );
    }

    private static Object defaultValue(Class<?> returnType) {
        if (returnType == boolean.class) {
            return false;
        }
        if (returnType == int.class) {
            return 0;
        }
        if (returnType == long.class) {
            return 0L;
        }
        if (returnType == float.class) {
            return 0f;
        }
        if (returnType == double.class) {
            return 0d;
        }
        return null;
    }

    /** Records every JavaScript call so tests can await and inspect the onRecallResult payload. */
    private static class RecordingJsCallback implements HandlerContext.JsCallback {
        final BlockingQueue<String[]> calls = new LinkedBlockingQueue<>();

        @Override
        public void callJavaScript(String functionName, String... args) {
            calls.add(new String[]{functionName, args.length > 0 ? args[0] : ""});
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }
    }
}
