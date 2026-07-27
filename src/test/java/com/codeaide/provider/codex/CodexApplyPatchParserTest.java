package com.codeaide.provider.codex;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class CodexApplyPatchParserTest {

    private static final String UPDATE_PATCH = String.join("\n",
            "*** Begin Patch",
            "*** Update File: src/main/App.java",
            "@@ -1,2 +1,2 @@",
            "-old line",
            "+new line",
            " context line",
            "*** End Patch");

    private static final String ADD_PATCH = String.join("\n",
            "*** Begin Patch",
            "*** Add File: src/new/File.java",
            "+first line",
            "+second line",
            "*** End Patch");

    // ---- extractPatchFromFunctionCall: SDK 0.144.x shell_command shapes ----

    @Test
    public void shellCommandArgvArrayExtractsPatch() {
        JsonArray command = new JsonArray();
        command.add("apply_patch");
        command.add(UPDATE_PATCH);
        JsonObject args = new JsonObject();
        args.add("command", command);

        assertEquals(UPDATE_PATCH,
                CodexApplyPatchParser.extractPatchFromFunctionCall("shell_command", args.toString()));
    }

    @Test
    public void shellCommandArgvArrayToleratesWrapperEntries() {
        JsonArray command = new JsonArray();
        command.add("bash");
        command.add("-lc");
        command.add("apply_patch <<'EOF'\n" + UPDATE_PATCH + "\nEOF");
        JsonObject args = new JsonObject();
        args.add("command", command);

        assertEquals(UPDATE_PATCH,
                CodexApplyPatchParser.extractPatchFromFunctionCall("shell_command", args.toString()));
    }

    @Test
    public void shellCommandStringFormExtractsPatch() {
        JsonObject args = new JsonObject();
        args.addProperty("command", "apply_patch <<'PATCH_EOF'\n" + UPDATE_PATCH + "\nPATCH_EOF");

        assertEquals(UPDATE_PATCH,
                CodexApplyPatchParser.extractPatchFromFunctionCall("shell_command", args.toString()));
    }

    @Test
    public void shellCommandCmdStringVariantExtractsPatch() {
        JsonObject args = new JsonObject();
        args.addProperty("cmd", "apply_patch " + UPDATE_PATCH);

        assertEquals(UPDATE_PATCH,
                CodexApplyPatchParser.extractPatchFromFunctionCall("shell_command", args.toString()));
    }

    // ---- extractPatchFromFunctionCall: legacy shapes ----

    @Test
    public void applyPatchFunctionCallReadsPatchField() {
        JsonObject args = new JsonObject();
        args.addProperty("patch", UPDATE_PATCH);

        assertEquals(UPDATE_PATCH,
                CodexApplyPatchParser.extractPatchFromFunctionCall("apply_patch", args.toString()));
    }

    @Test
    public void execCommandReadsCmdString() {
        JsonObject args = new JsonObject();
        args.addProperty("cmd", "apply_patch <<'EOF'\n" + UPDATE_PATCH + "\nEOF");

        assertEquals(UPDATE_PATCH,
                CodexApplyPatchParser.extractPatchFromFunctionCall("exec_command", args.toString()));
    }

    // ---- extractPatchFromFunctionCall: malformed input ----

    @Test
    public void malformedArgumentsReturnEmpty() {
        assertEquals("", CodexApplyPatchParser.extractPatchFromFunctionCall("shell_command", "{\"command\": ["));
        assertEquals("", CodexApplyPatchParser.extractPatchFromFunctionCall("shell_command", null));
        assertEquals("", CodexApplyPatchParser.extractPatchFromFunctionCall(null, "{}"));
        assertEquals("", CodexApplyPatchParser.extractPatchFromFunctionCall("read_file", "{\"command\":[\"apply_patch\",\"x\"]}"));
    }

    @Test
    public void missingPatchMarkersReturnEmpty() {
        JsonArray command = new JsonArray();
        command.add("apply_patch");
        command.add("--help");
        JsonObject args = new JsonObject();
        args.add("command", command);

        assertEquals("", CodexApplyPatchParser.extractPatchFromFunctionCall("shell_command", args.toString()));

        JsonObject noEnd = new JsonObject();
        noEnd.addProperty("command", "apply_patch *** Begin Patch\n*** Update File: a.java\n+x");
        assertEquals("", CodexApplyPatchParser.extractPatchFromFunctionCall("shell_command", noEnd.toString()));
    }

    // ---- extractPatchFromCustomToolCallInput ----

    @Test
    public void customToolCallInputStringAndObjectForms() {
        assertEquals(UPDATE_PATCH,
                CodexApplyPatchParser.extractPatchFromCustomToolCallInput(
                        new JsonPrimitive(UPDATE_PATCH)));

        JsonObject input = new JsonObject();
        input.addProperty("patch", UPDATE_PATCH);
        assertEquals(UPDATE_PATCH, CodexApplyPatchParser.extractPatchFromCustomToolCallInput(input));

        assertEquals("", CodexApplyPatchParser.extractPatchFromCustomToolCallInput(null));
    }

    // ---- parse ----

    @Test
    public void parsesUpdateOperationWithHunkLineNumbers() {
        List<CodexApplyPatchParser.PatchOperation> ops = CodexApplyPatchParser.parse(UPDATE_PATCH);

        assertEquals(1, ops.size());
        CodexApplyPatchParser.PatchOperation op = ops.get(0);
        assertEquals("src/main/App.java", op.filePath);
        assertEquals("update", op.kind);
        assertEquals("edit", op.toolName());
        assertEquals("old line\ncontext line", op.oldString);
        assertEquals("new line\ncontext line", op.newString);
        assertEquals(Integer.valueOf(1), op.startLine);
        assertEquals(Integer.valueOf(2), op.endLine);
    }

    @Test
    public void parsesAddOperationAsWrite() {
        List<CodexApplyPatchParser.PatchOperation> ops = CodexApplyPatchParser.parse(ADD_PATCH);

        assertEquals(1, ops.size());
        CodexApplyPatchParser.PatchOperation op = ops.get(0);
        assertEquals("src/new/File.java", op.filePath);
        assertEquals("add", op.kind);
        assertEquals("write", op.toolName());
        assertEquals("", op.oldString);
        assertEquals("first line\nsecond line", op.newString);
        assertNull(op.startLine);
    }

    @Test
    public void parsesMultiFilePatchInOrder() {
        String patch = String.join("\n",
                "*** Begin Patch",
                "*** Update File: src/main/App.java",
                "@@ -1 +1 @@",
                "-old line",
                "+new line",
                "*** Add File: src/new/File.java",
                "+first line",
                "*** End Patch");

        List<CodexApplyPatchParser.PatchOperation> ops = CodexApplyPatchParser.parse(patch);

        assertEquals(2, ops.size());
        assertEquals("edit", ops.get(0).toolName());
        assertEquals("write", ops.get(1).toolName());
    }

    @Test
    public void deleteSectionsAreDropped() {
        String patch = String.join("\n",
                "*** Begin Patch",
                "*** Delete File: src/old/File.java",
                "*** End Patch");

        assertTrue(CodexApplyPatchParser.parse(patch).isEmpty());
    }

    @Test
    public void blankTextParsesToNoOperations() {
        assertTrue(CodexApplyPatchParser.parse("").isEmpty());
        assertTrue(CodexApplyPatchParser.parse(null).isEmpty());
    }
}
