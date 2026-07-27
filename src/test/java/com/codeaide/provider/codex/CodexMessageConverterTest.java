package com.codeaide.provider.codex;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class CodexMessageConverterTest {

    // ---- convertFunctionCallOutputToToolResult ----

    @Test
    public void toolResultWithStringOutput() {
        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-1");
        payload.addProperty("output", "command executed successfully");

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, "2026-04-20T00:00:00Z");

        assertEquals("user", result.get("type").getAsString());
        assertEquals("2026-04-20T00:00:00Z", result.get("timestamp").getAsString());

        JsonObject toolResult = extractFirstToolResult(result);
        assertEquals("tool_result", toolResult.get("type").getAsString());
        assertEquals("call-1", toolResult.get("tool_use_id").getAsString());
        assertEquals("command executed successfully", toolResult.get("content").getAsString());
    }

    @Test
    public void toolResultWithJsonObjectOutput() {
        JsonObject structured = new JsonObject();
        structured.addProperty("status", "ok");
        structured.addProperty("code", 200);

        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-2");
        payload.add("output", structured);

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);

        assertNull(result.get("timestamp"));

        JsonObject toolResult = extractFirstToolResult(result);
        String content = toolResult.get("content").getAsString();
        assertTrue("Should contain serialized JSON object", content.contains("\"status\":\"ok\""));
        assertTrue("Should contain serialized JSON object", content.contains("\"code\":200"));
    }

    @Test
    public void toolResultWithJsonArrayOutput() {
        JsonArray array = new JsonArray();
        array.add("item1");
        array.add("item2");

        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-3");
        payload.add("output", array);

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);

        JsonObject toolResult = extractFirstToolResult(result);
        String content = toolResult.get("content").getAsString();
        assertTrue("Should contain serialized JSON array", content.contains("item1"));
        assertTrue("Should contain serialized JSON array", content.contains("item2"));
    }

    @Test
    public void toolResultWithNullOutput() {
        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-4");
        payload.add("output", JsonNull.INSTANCE);

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);

        JsonObject toolResult = extractFirstToolResult(result);
        assertEquals("", toolResult.get("content").getAsString());
    }

    @Test
    public void toolResultWithMissingOutputField() {
        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-5");

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);

        JsonObject toolResult = extractFirstToolResult(result);
        assertEquals("", toolResult.get("content").getAsString());
    }

    @Test
    public void toolResultWithMissingCallId() {
        JsonObject payload = new JsonObject();
        payload.addProperty("output", "some output");

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);

        JsonObject toolResult = extractFirstToolResult(result);
        assertEquals("unknown", toolResult.get("tool_use_id").getAsString());
    }

    @Test
    public void toolResultTimestampIncludedWhenProvided() {
        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-6");
        payload.addProperty("output", "ok");

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, "2026-01-01T12:00:00Z");
        assertEquals("2026-01-01T12:00:00Z", result.get("timestamp").getAsString());
    }

    @Test
    public void toolResultTimestampOmittedWhenNull() {
        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-7");
        payload.addProperty("output", "ok");

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);
        assertNull(result.get("timestamp"));
    }

    @Test
    public void functionCallNormalizesShellCommandToolName() {
        JsonObject payload = new JsonObject();
        payload.addProperty("name", "shell_command");
        payload.addProperty("call_id", "call-shell-1");
        payload.addProperty("arguments", "{\"command\":\"ls src\"}");

        JsonObject result = CodexMessageConverter.convertFunctionCallToToolUse(payload, null);

        assertEquals("assistant", result.get("type").getAsString());
        assertEquals("Tool: glob", result.get("content").getAsString());

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("call-shell-1", toolUse.get("id").getAsString());
        assertEquals("glob", toolUse.get("name").getAsString());
        assertEquals("ls src", toolUse.getAsJsonObject("input").get("command").getAsString());
    }


    @Test
    public void customToolCallWithStringInput() {
        JsonObject payload = new JsonObject();
        payload.addProperty("name", "apply_patch");
        payload.addProperty("call_id", "custom-1");
        payload.addProperty("input", "some patch content");

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        assertEquals("assistant", result.get("type").getAsString());
        assertEquals("Tool: apply_patch", result.get("content").getAsString());

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("custom-1", toolUse.get("id").getAsString());
        assertEquals("apply_patch", toolUse.get("name").getAsString());
        assertEquals("some patch content", toolUse.getAsJsonObject("input").get("patch").getAsString());
    }

    @Test
    public void customToolCallWithJsonObjectInput() {
        JsonObject structuredInput = new JsonObject();
        structuredInput.addProperty("file", "test.py");
        structuredInput.addProperty("action", "create");

        JsonObject payload = new JsonObject();
        payload.addProperty("name", "mcp_tool");
        payload.addProperty("call_id", "custom-2");
        payload.add("input", structuredInput);

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        String patchValue = toolUse.getAsJsonObject("input").get("patch").getAsString();
        assertTrue("Should contain serialized JSON", patchValue.contains("test.py"));
    }

    @Test
    public void customToolCallWithMissingInput() {
        JsonObject payload = new JsonObject();
        payload.addProperty("name", "some_tool");
        payload.addProperty("call_id", "custom-3");

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("", toolUse.getAsJsonObject("input").get("patch").getAsString());
    }

    @Test
    public void customToolCallExtractsFilePathFromApplyPatch() {
        String patchContent = "*** Update File: src/main/App.java\n--- old\n+++ new\n@@ -1 +1 @@\n-old line\n+new line";

        JsonObject payload = new JsonObject();
        payload.addProperty("name", "apply_patch");
        payload.addProperty("call_id", "custom-4");
        payload.addProperty("input", patchContent);

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        JsonObject input = toolUse.getAsJsonObject("input");
        assertEquals("src/main/App.java", input.get("file_path").getAsString());
    }

    @Test
    public void customToolCallExtractsFilePathFromAddFile() {
        String patchContent = "*** Add File: src/new/File.java\n+new content";

        JsonObject payload = new JsonObject();
        payload.addProperty("name", "apply_patch");
        payload.addProperty("call_id", "custom-5");
        payload.addProperty("input", patchContent);

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        JsonObject input = toolUse.getAsJsonObject("input");
        assertEquals("src/new/File.java", input.get("file_path").getAsString());
    }

    @Test
    public void customToolCallWithMissingNameAndCallId() {
        JsonObject payload = new JsonObject();
        payload.addProperty("input", "data");

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("unknown", toolUse.get("name").getAsString());
        assertEquals("unknown", toolUse.get("id").getAsString());
    }

    // ---- convertFunctionCallToToolUse: cmd -> command mapping for history replay ----

    @Test
    public void execCommandHistoryMapsCmdToCommand() {
        // Codex history stores exec_command arguments with `cmd` field, but
        // BashToolGroupBlock.parseBashItem reads input.command. Without mapping
        // the timeline rows render blank when replaying a Codex history session.
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "exec_command");
        payload.addProperty("call_id", "call-cmd-1");
        payload.addProperty("arguments",
                "{\"cmd\":\"sed -n '1,10p' README.md\",\"workdir\":\"/tmp/x\",\"yield_time_ms\":1000}");

        JsonObject result = CodexMessageConverter.convertFunctionCallToToolUse(payload, "2026-05-22T08:13:18Z");

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("exec_command", toolUse.get("name").getAsString());
        JsonObject input = toolUse.getAsJsonObject("input");
        // Original cmd is preserved (downstream tooling may still rely on it)
        assertEquals("sed -n '1,10p' README.md", input.get("cmd").getAsString());
        // New command field powers BashToolGroupBlock / BashToolBlock rendering
        assertEquals("sed -n '1,10p' README.md", input.get("command").getAsString());
    }

    @Test
    public void shellCommandHistoryMapsCmdToCommandWhenNotRenamed() {
        // shell_command stays as shell_command (not renamed to glob/read) when
        // the cmd doesn't match the ls/cat/grep patterns. Still needs the mapping.
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "shell_command");
        payload.addProperty("call_id", "call-cmd-2");
        payload.addProperty("arguments", "{\"cmd\":\"npm test\"}");

        JsonObject result = CodexMessageConverter.convertFunctionCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("npm test", toolUse.getAsJsonObject("input").get("command").getAsString());
    }

    @Test
    public void execCommandPreservesExistingCommandField() {
        // Defensive: if upstream already supplies command, do not overwrite it.
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "exec_command");
        payload.addProperty("call_id", "call-cmd-3");
        payload.addProperty("arguments", "{\"cmd\":\"raw\",\"command\":\"already-set\"}");

        JsonObject result = CodexMessageConverter.convertFunctionCallToToolUse(payload, null);

        JsonObject input = extractFirstBlock(result).getAsJsonObject("input");
        assertEquals("already-set", input.get("command").getAsString());
        assertEquals("raw", input.get("cmd").getAsString());
    }

    // ---- convertFunctionCallToToolUseMessages / convertCustomToolCallToToolUseMessages: apply_patch synthesis ----

    private static final String UPDATE_PATCH = String.join("\n",
            "*** Begin Patch",
            "*** Update File: src/main/App.java",
            "@@ -1,2 +1,2 @@",
            "-old line",
            "+new line",
            " context line",
            "*** End Patch");

    @Test
    public void shellCommandArgvApplyPatchSynthesizesEditToolUse() {
        // SDK 0.144.x persists file edits as shell_command with an argv array.
        JsonArray command = new JsonArray();
        command.add("apply_patch");
        command.add(UPDATE_PATCH);
        JsonObject args = new JsonObject();
        args.add("command", command);

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "shell_command");
        payload.addProperty("call_id", "call-patch-1");
        payload.addProperty("arguments", args.toString());

        List<JsonObject> messages = CodexMessageConverter.convertFunctionCallToToolUseMessages(payload, "2026-07-26T00:00:00Z");

        assertEquals(1, messages.size());
        JsonObject toolUse = extractFirstBlock(messages.get(0));
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("edit", toolUse.get("name").getAsString());
        // First operation keeps the original call_id so it pairs with the real
        // function_call_output tool_result during history replay.
        assertEquals("call-patch-1", toolUse.get("id").getAsString());
        JsonObject input = toolUse.getAsJsonObject("input");
        assertEquals("src/main/App.java", input.get("file_path").getAsString());
        assertEquals("old line\ncontext line", input.get("old_string").getAsString());
        assertEquals("new line\ncontext line", input.get("new_string").getAsString());
    }

    @Test
    public void multiFilePatchSynthesizesToolResultsForExtraOperations() {
        String patch = String.join("\n",
                "*** Begin Patch",
                "*** Update File: src/main/App.java",
                "@@ -1 +1 @@",
                "-old line",
                "+new line",
                "*** Add File: src/new/File.java",
                "+first line",
                "*** End Patch");
        JsonArray command = new JsonArray();
        command.add("apply_patch");
        command.add(patch);
        JsonObject args = new JsonObject();
        args.add("command", command);

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "shell_command");
        payload.addProperty("call_id", "call-patch-2");
        payload.addProperty("arguments", args.toString());

        List<JsonObject> messages = CodexMessageConverter.convertFunctionCallToToolUseMessages(payload, null);

        assertEquals(2, messages.size());

        JsonObject assistantMsg = messages.get(0);
        assertEquals("assistant", assistantMsg.get("type").getAsString());
        JsonArray blocks = assistantMsg.getAsJsonObject("raw").getAsJsonArray("content");
        assertEquals(2, blocks.size());

        JsonObject first = blocks.get(0).getAsJsonObject();
        assertEquals("edit", first.get("name").getAsString());
        assertEquals("call-patch-2", first.get("id").getAsString());

        JsonObject second = blocks.get(1).getAsJsonObject();
        assertEquals("write", second.get("name").getAsString());
        assertEquals("call-patch-2__patch_1", second.get("id").getAsString());
        assertEquals("src/new/File.java", second.getAsJsonObject("input").get("file_path").getAsString());
        assertEquals("first line", second.getAsJsonObject("input").get("new_string").getAsString());

        // Extra operations get a synthesized result so the edit list treats them as applied,
        // mirroring the realtime bridge path.
        JsonObject userMsg = messages.get(1);
        assertEquals("user", userMsg.get("type").getAsString());
        JsonObject toolResult = userMsg.getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("tool_result", toolResult.get("type").getAsString());
        assertEquals("call-patch-2__patch_1", toolResult.get("tool_use_id").getAsString());
        assertEquals("Patch applied", toolResult.get("content").getAsString());
    }

    @Test
    public void shellCommandArgvNonPatchDoesNotCrashAndFlattensCommand() {
        // SDK 0.144.x argv arrays used to crash convertToolName via JsonArray.getAsString().
        JsonArray command = new JsonArray();
        command.add("ls");
        command.add("-la");
        JsonObject args = new JsonObject();
        args.add("command", command);

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "shell_command");
        payload.addProperty("call_id", "call-ls-1");
        payload.addProperty("arguments", args.toString());

        List<JsonObject> messages = CodexMessageConverter.convertFunctionCallToToolUseMessages(payload, null);

        assertEquals(1, messages.size());
        JsonObject toolUse = extractFirstBlock(messages.get(0));
        assertEquals("glob", toolUse.get("name").getAsString());
        assertEquals("ls -la", toolUse.getAsJsonObject("input").get("command").getAsString());
    }

    @Test
    public void customToolCallApplyPatchSynthesizesWriteToolUse() {
        String addPatch = String.join("\n",
                "*** Begin Patch",
                "*** Add File: src/new/File.java",
                "+first line",
                "*** End Patch");

        JsonObject payload = new JsonObject();
        payload.addProperty("name", "apply_patch");
        payload.addProperty("call_id", "custom-patch-1");
        payload.addProperty("input", addPatch);

        List<JsonObject> messages = CodexMessageConverter.convertCustomToolCallToToolUseMessages(payload, null);

        assertEquals(1, messages.size());
        JsonObject toolUse = extractFirstBlock(messages.get(0));
        assertEquals("write", toolUse.get("name").getAsString());
        assertEquals("custom-patch-1", toolUse.get("id").getAsString());
        JsonObject input = toolUse.getAsJsonObject("input");
        assertEquals("src/new/File.java", input.get("file_path").getAsString());
        assertEquals("", input.get("old_string").getAsString());
        assertEquals("first line", input.get("new_string").getAsString());
    }

    @Test
    public void customToolCallApplyPatchWithoutOperationsKeepsLegacyShape() {
        JsonObject payload = new JsonObject();
        payload.addProperty("name", "apply_patch");
        payload.addProperty("call_id", "custom-patch-2");
        payload.addProperty("input", "some patch content");

        List<JsonObject> messages = CodexMessageConverter.convertCustomToolCallToToolUseMessages(payload, null);

        assertEquals(1, messages.size());
        JsonObject toolUse = extractFirstBlock(messages.get(0));
        assertEquals("apply_patch", toolUse.get("name").getAsString());
        assertEquals("some patch content", toolUse.getAsJsonObject("input").get("patch").getAsString());
    }

    @Test
    public void writeStdinFunctionCallMessagesReturnsEmptyList() {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "write_stdin");
        payload.addProperty("call_id", "call-stdin-1");
        payload.addProperty("arguments", "{\"session_id\":1,\"chars\":\"x\"}");

        List<JsonObject> messages = CodexMessageConverter.convertFunctionCallToToolUseMessages(payload, null);

        assertTrue(messages.isEmpty());
    }

    // ---- helpers ----

    private static JsonObject extractFirstToolResult(JsonObject frontendMsg) {
        return frontendMsg.getAsJsonObject("raw")
                .getAsJsonArray("content")
                .get(0)
                .getAsJsonObject();
    }

    private static JsonObject extractFirstBlock(JsonObject frontendMsg) {
        return frontendMsg.getAsJsonObject("raw")
                .getAsJsonArray("content")
                .get(0)
                .getAsJsonObject();
    }
}
