package com.codeaide.handler.history;

import com.codeaide.handler.core.HandlerContext;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.lang.reflect.Proxy;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class HistoryMessageInjectorTest {

    @Test
    public void handleLoadSessionUsesPayloadProviderAndResolvedCodexSessionId() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext("D:/project/demo"));
        boolean[] callbackInvoked = {false};

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-codex\",\"provider\":\"codex\"}",
                "claude",
                (sessionId, projectPath, provider) -> callbackInvoked[0] = true
        );

        assertEquals("hist-codex", injector.loadedCodexSessionId);
        assertFalse(callbackInvoked[0]);
    }

    @Test
    public void handleLoadSessionUsesPayloadProviderForClaudeEvenWhenCurrentProviderIsCodex() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext("D:/project/demo"));
        String[] callbackArgs = new String[3];

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-claude\",\"provider\":\"claude\"}",
                "codex",
                (sessionId, projectPath, provider) -> {
                    callbackArgs[0] = sessionId;
                    callbackArgs[1] = projectPath;
                    callbackArgs[2] = provider;
                }
        );

        assertNull(injector.loadedCodexSessionId);
        assertEquals("hist-claude", callbackArgs[0]);
        assertEquals("D:/project/demo", callbackArgs[1]);
        assertEquals("claude", callbackArgs[2]);
    }

    @Test
    public void convertCodexMessagesDeduplicatesDualRecordedUserMessage() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("user", result.get(0).get("type").getAsString());
        assertEquals("hello", result.get(0).get("content").getAsString());
    }

    @Test
    public void convertCodexMessagesKeepsRepeatedUserMessagesWithDifferentTimestamps() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:27.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());
    }

    @Test
    public void convertCodexMessagesDeduplicatesImageWrappedDualRecordedUserMessage() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "<image name=[Image #1]>\n</image>\nhello"));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("<image name=[Image #1]>\n</image>\nhello", result.get(0).get("content").getAsString());
    }

    @Test
    public void convertCodexMessagesStripsAgentsInstructionsFromDuplicatedUserMessage() {
        String text = "<agents-instructions>\n"
                + "# Global Instructions\n\n"
                + "请默认使用中文（简体）回复。\n"
                + "</agents-instructions>\n\n"
                + "hello";
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", text));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", text));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("hello", result.get(0).get("content").getAsString());
        assertEquals("hello", result.get(0)
                .getAsJsonObject("raw")
                .getAsJsonArray("content")
                .get(0)
                .getAsJsonObject()
                .get("text")
                .getAsString());
    }

    @Test
    public void convertCodexMessagesRestoresLocalImagesFromEventMessage() throws Exception {
        Path imagePath = Files.createTempFile("codex-history-image", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonArray messages = new JsonArray();
            messages.add(eventUserMessage("2026-05-11T09:02:20.861Z", "hello", imagePath.toString()));

            List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

            assertEquals(1, result.size());
            JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
            assertEquals(2, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertEquals("image/png", contentBlocks.get(0).getAsJsonObject().get("mediaType").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString().startsWith("data:image/png;base64,"));
            assertEquals("text", contentBlocks.get(1).getAsJsonObject().get("type").getAsString());
            assertEquals("hello", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void convertCodexMessagesFiltersDeveloperRoleMessages() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemDeveloperMessage("2026-05-14T10:00:00.000Z", "internal developer instructions"));
        messages.add(responseItemAssistantMessage("2026-05-14T10:00:01.000Z", "visible assistant reply"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("assistant", result.get(0).get("type").getAsString());
        assertEquals("visible assistant reply", result.get(0).get("content").getAsString());
    }

    @Test
    public void convertCodexMessagesKeepsImageOnlyEventMessage() throws Exception {
        Path imagePath = Files.createTempFile("codex-history-image-only", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonArray messages = new JsonArray();
            messages.add(eventUserMessage("2026-05-11T09:03:20.861Z", "", imagePath.toString()));

            List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

            assertEquals(1, result.size());
            assertEquals("", result.get(0).get("content").getAsString());
            JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
            assertEquals(1, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString().startsWith("data:image/png;base64,"));
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void convertCodexMessagesStripsAppendedProjectModulesContext() {
        JsonArray messages = new JsonArray();
        messages.add(eventUserMessage(
                "2026-05-11T09:03:20.861Z",
                "只保留用户输入\n\n## Project Modules\n\nThis project contains multiple modules:\n- `codeaide`\n"
        ));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("只保留用户输入", result.get(0).get("content").getAsString());
        JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
        assertEquals(1, contentBlocks.size());
        assertEquals("只保留用户输入", contentBlocks.get(0).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void convertCodexMessagesSynthesizesEditToolUseFromShellCommandPatch() {
        // SDK 0.144.x rollout shape: apply_patch persisted as shell_command argv array.
        String patch = String.join("\n",
                "*** Begin Patch",
                "*** Update File: src/main/App.java",
                "@@ -1 +1 @@",
                "-old line",
                "+new line",
                "*** End Patch");
        JsonArray command = new JsonArray();
        command.add("apply_patch");
        command.add(patch);
        JsonObject args = new JsonObject();
        args.add("command", command);

        JsonArray messages = new JsonArray();
        messages.add(responseItemFunctionCall("2026-07-26T10:00:00.000Z", "shell_command", "call-1", args.toString()));
        messages.add(responseItemFunctionCallOutput("2026-07-26T10:00:01.000Z", "function_call_output", "call-1", "Success. Updated files."));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());

        JsonObject toolUse = result.get(0).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("edit", toolUse.get("name").getAsString());
        assertEquals("call-1", toolUse.get("id").getAsString());
        assertEquals("src/main/App.java", toolUse.getAsJsonObject("input").get("file_path").getAsString());

        // The real function_call_output pairs with the synthesized tool_use via call_id.
        JsonObject toolResult = result.get(1).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("tool_result", toolResult.get("type").getAsString());
        assertEquals("call-1", toolResult.get("tool_use_id").getAsString());
    }

    @Test
    public void convertCodexMessagesPairsCustomToolCallPatchWithItsOutput() {
        String patch = String.join("\n",
                "*** Begin Patch",
                "*** Add File: src/new/File.java",
                "+first line",
                "*** End Patch");

        JsonArray messages = new JsonArray();
        messages.add(responseItemCustomToolCall("2026-07-26T10:00:00.000Z", "apply_patch", "call-2", patch));
        messages.add(responseItemFunctionCallOutput("2026-07-26T10:00:01.000Z", "custom_tool_call_output", "call-2", "Success."));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());

        JsonObject toolUse = result.get(0).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("write", toolUse.get("name").getAsString());
        assertEquals("call-2", toolUse.get("id").getAsString());

        // custom_tool_call_output was previously dropped, leaving the tool_use unpaired.
        JsonObject toolResult = result.get(1).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("tool_result", toolResult.get("type").getAsString());
        assertEquals("call-2", toolResult.get("tool_use_id").getAsString());
    }

    private static JsonObject responseItemFunctionCall(String timestamp, String name, String callId, String arguments) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", name);
        payload.addProperty("call_id", callId);
        payload.addProperty("arguments", arguments);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject responseItemCustomToolCall(String timestamp, String name, String callId, String input) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "custom_tool_call");
        payload.addProperty("name", name);
        payload.addProperty("call_id", callId);
        payload.addProperty("input", input);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject responseItemFunctionCallOutput(String timestamp, String payloadType, String callId, String output) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", payloadType);
        payload.addProperty("call_id", callId);
        payload.addProperty("output", output);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject responseItemUserMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "user", "input_text", text);
    }

    private static JsonObject responseItemDeveloperMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "developer", "text", text);
    }

    private static JsonObject responseItemAssistantMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "assistant", "output_text", text);
    }

    private static JsonObject responseItemMessage(String timestamp, String role, String blockType, String text) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "message");
        payload.addProperty("role", role);

        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", blockType);
        block.addProperty("text", text);
        content.add(block);

        payload.add("content", content);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject eventUserMessage(String timestamp, String text) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "event_msg");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "user_message");
        payload.addProperty("message", text);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject eventUserMessage(String timestamp, String text, String localImagePath) {
        JsonObject line = eventUserMessage(timestamp, text);
        JsonArray localImages = new JsonArray();
        localImages.add(localImagePath);
        line.getAsJsonObject("payload").add("local_images", localImages);
        return line;
    }

    private static HandlerContext createContext(String basePath) {
        Project project = (Project) Proxy.newProxyInstance(
                HistoryMessageInjectorTest.class.getClassLoader(),
                new Class[]{Project.class},
                (proxy, method, args) -> {
                    if ("getBasePath".equals(method.getName())) {
                        return basePath;
                    }
                    if ("isDisposed".equals(method.getName())) {
                        return false;
                    }
                    Class<?> returnType = method.getReturnType();
                    if (returnType.equals(boolean.class)) {
                        return false;
                    }
                    if (returnType.equals(int.class)) {
                        return 0;
                    }
                    if (returnType.equals(long.class)) {
                        return 0L;
                    }
                    return null;
                }
        );

        return new HandlerContext(project, null, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        });
    }

    private static final class RecordingHistoryMessageInjector extends HistoryMessageInjector {
        private String loadedCodexSessionId;

        private RecordingHistoryMessageInjector(HandlerContext context) {
            super(context);
        }

        @Override
        void loadCodexSession(String sessionId) {
            this.loadedCodexSessionId = sessionId;
        }
    }
}
