package com.codeaide.provider.codex;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parser for Codex apply_patch payloads.
 *
 * Java port of ai-bridge/services/codex/codex-patch-parser.js so history replay can
 * reconstruct the same edit/write operations the realtime path synthesizes.
 * Covers extraction from the SDK 0.144.x shell_command shape (argv array or string)
 * plus the legacy exec_command / apply_patch / custom_tool_call shapes.
 */
public final class CodexApplyPatchParser {

    private static final String BEGIN_MARKER = "*** Begin Patch";
    private static final String END_MARKER = "*** End Patch";
    private static final String UPDATE_PREFIX = "*** Update File: ";
    private static final String ADD_PREFIX = "*** Add File: ";
    private static final String DELETE_PREFIX = "*** Delete File: ";
    private static final String MOVE_PREFIX = "*** Move to: ";
    private static final Pattern HUNK_HEADER =
            Pattern.compile("^@@\\s+-(\\d+)(?:,(\\d+))?\\s+\\+(\\d+)(?:,(\\d+))?\\s+@@");

    private CodexApplyPatchParser() {
    }

    /** A single file operation extracted from an apply_patch payload. */
    public static final class PatchOperation {
        public final String filePath;
        /** add | update (delete sections are dropped, matching the JS realtime path) */
        public final String kind;
        public final String oldString;
        public final String newString;
        public final Integer startLine;
        public final Integer endLine;

        PatchOperation(String filePath, String kind, String oldString, String newString,
                       Integer startLine, Integer endLine) {
            this.filePath = filePath;
            this.kind = kind;
            this.oldString = oldString;
            this.newString = newString;
            this.startLine = startLine;
            this.endLine = endLine;
        }

        /** edit for updates, write for new files — same naming as the realtime path. */
        public String toolName() {
            return "add".equals(kind) ? "write" : "edit";
        }
    }

    /**
     * Slice the patch text between the Begin/End markers out of a shell command string.
     * Returns "" when the markers are missing or malformed.
     */
    public static String extractPatchSlice(String command) {
        if (command == null || command.isEmpty()) {
            return "";
        }
        int begin = command.indexOf(BEGIN_MARKER);
        int end = command.lastIndexOf(END_MARKER);
        if (begin < 0 || end < begin) {
            return "";
        }
        return command.substring(begin, end + END_MARKER.length());
    }

    /**
     * Extract apply_patch text from function_call arguments.
     * Supports name=apply_patch ({patch}/{input} fields), name=exec_command ({cmd} string),
     * and the SDK 0.144.x name=shell_command ({command} argv array or string, or {cmd} string).
     *
     * @return patch text, or "" when the payload does not carry a parseable patch
     */
    public static String extractPatchFromFunctionCall(String name, String argumentsJson) {
        if (name == null || argumentsJson == null || argumentsJson.isEmpty()) {
            return "";
        }
        JsonObject args;
        try {
            JsonElement parsed = JsonParser.parseString(argumentsJson);
            if (!parsed.isJsonObject()) {
                return "";
            }
            args = parsed.getAsJsonObject();
        } catch (Exception e) {
            return "";
        }

        if ("apply_patch".equals(name)) {
            String patch = optString(args, "patch");
            if (patch == null) {
                patch = optString(args, "input");
            }
            return patch != null ? patch : "";
        }

        if ("exec_command".equals(name)) {
            return extractPatchSlice(optString(args, "cmd"));
        }

        if ("shell_command".equals(name)) {
            JsonElement command = args.has("command") ? args.get("command") : args.get("cmd");
            if (command != null && command.isJsonArray()) {
                // argv form: ["apply_patch", "*** Begin Patch\n..."] — the patch text is the
                // argv entry carrying the markers (tolerate wrappers like bash -lc).
                for (JsonElement entry : command.getAsJsonArray()) {
                    if (!entry.isJsonPrimitive() || !entry.getAsJsonPrimitive().isString()) {
                        continue;
                    }
                    String value = entry.getAsString();
                    if ("apply_patch".equals(value)) {
                        continue;
                    }
                    if (value.contains(BEGIN_MARKER)) {
                        return extractPatchSlice(value);
                    }
                }
                return "";
            }
            return extractPatchSlice(command != null && command.isJsonPrimitive()
                    && command.getAsJsonPrimitive().isString() ? command.getAsString() : null);
        }

        return "";
    }

    /**
     * Extract apply_patch text from a custom_tool_call input (string or {patch}/{input} object).
     */
    public static String extractPatchFromCustomToolCallInput(JsonElement input) {
        if (input == null || input.isJsonNull()) {
            return "";
        }
        if (input.isJsonPrimitive() && input.getAsJsonPrimitive().isString()) {
            return input.getAsString();
        }
        if (input.isJsonObject()) {
            JsonObject obj = input.getAsJsonObject();
            String patch = optString(obj, "patch");
            if (patch == null) {
                patch = optString(obj, "input");
            }
            return patch != null ? patch : "";
        }
        return "";
    }

    private static String optString(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || !obj.get(key).isJsonPrimitive()
                || !obj.get(key).getAsJsonPrimitive().isString()) {
            return null;
        }
        return obj.get(key).getAsString();
    }

    /**
     * Parse apply_patch text into file operations (add -&gt; write, update -&gt; edit).
     * Delete sections are dropped, matching the JS realtime path.
     */
    public static List<PatchOperation> parse(String patchText) {
        List<PatchOperation> operations = new ArrayList<>();
        if (patchText == null || patchText.trim().isEmpty()) {
            return operations;
        }

        String currentPath = null;
        String currentKind = null; // add | update | delete
        int[] hunkHeader = null; // [oldStart, oldCount, newStart, newCount]
        StringBuilder oldLines = new StringBuilder();
        StringBuilder newLines = new StringBuilder();
        StringBuilder addFileLines = new StringBuilder();
        boolean oldHasContent = false;
        boolean newHasContent = false;
        boolean addHasContent = false;

        for (String rawLine : patchText.split("\n", -1)) {
            String line = rawLine == null ? "" : rawLine;

            if (line.startsWith(UPDATE_PREFIX) || line.startsWith(ADD_PREFIX) || line.startsWith(DELETE_PREFIX)) {
                // flush pending section
                if (currentPath != null && "update".equals(currentKind)) {
                    buildUpdateOperation(operations, currentPath,
                            oldLines, newLines, oldHasContent, newHasContent, hunkHeader);
                } else if (currentPath != null && "add".equals(currentKind)) {
                    operations.add(new PatchOperation(currentPath, "add", "",
                            stripTrailingNewline(addFileLines, addHasContent), null, null));
                }
                if (line.startsWith(UPDATE_PREFIX)) {
                    currentPath = line.substring(UPDATE_PREFIX.length()).trim();
                    currentKind = "update";
                } else if (line.startsWith(ADD_PREFIX)) {
                    currentPath = line.substring(ADD_PREFIX.length()).trim();
                    currentKind = "add";
                } else {
                    currentPath = line.substring(DELETE_PREFIX.length()).trim();
                    currentKind = "delete";
                }
                hunkHeader = null;
                oldLines.setLength(0);
                newLines.setLength(0);
                addFileLines.setLength(0);
                oldHasContent = false;
                newHasContent = false;
                addHasContent = false;
                continue;
            }

            if (line.startsWith(MOVE_PREFIX)) {
                String movedPath = line.substring(MOVE_PREFIX.length()).trim();
                if (!movedPath.isEmpty()) {
                    currentPath = movedPath;
                }
                continue;
            }

            if (line.startsWith(END_MARKER)) {
                if (currentPath != null && "update".equals(currentKind)) {
                    buildUpdateOperation(operations, currentPath,
                            oldLines, newLines, oldHasContent, newHasContent, hunkHeader);
                } else if (currentPath != null && "add".equals(currentKind)) {
                    operations.add(new PatchOperation(currentPath, "add", "",
                            stripTrailingNewline(addFileLines, addHasContent), null, null));
                }
                currentPath = null;
                currentKind = null;
                hunkHeader = null;
                oldLines.setLength(0);
                newLines.setLength(0);
                addFileLines.setLength(0);
                oldHasContent = false;
                newHasContent = false;
                addHasContent = false;
                continue;
            }

            if (currentPath == null || currentKind == null || "delete".equals(currentKind)) {
                continue;
            }

            if ("add".equals(currentKind)) {
                if (line.startsWith("+")) {
                    appendLine(addFileLines, line.substring(1));
                    addHasContent = true;
                }
                continue;
            }

            // update
            if (line.startsWith("@@")) {
                buildUpdateOperation(operations, currentPath,
                        oldLines, newLines, oldHasContent, newHasContent, hunkHeader);
                oldLines.setLength(0);
                newLines.setLength(0);
                oldHasContent = false;
                newHasContent = false;
                hunkHeader = parseHunkHeader(line);
                continue;
            }

            if (line.equals("\\ No newline at end of file")) {
                continue;
            }

            if (line.startsWith("+")) {
                appendLine(newLines, line.substring(1));
                newHasContent = true;
            } else if (line.startsWith("-")) {
                appendLine(oldLines, line.substring(1));
                oldHasContent = true;
            } else if (line.startsWith(" ")) {
                String content = line.substring(1);
                appendLine(oldLines, content);
                appendLine(newLines, content);
                oldHasContent = true;
                newHasContent = true;
            }
        }

        // flush trailing section
        if (currentPath != null && "update".equals(currentKind)) {
            buildUpdateOperation(operations, currentPath,
                    oldLines, newLines, oldHasContent, newHasContent, hunkHeader);
        } else if (currentPath != null && "add".equals(currentKind)) {
            operations.add(new PatchOperation(currentPath, "add", "",
                    stripTrailingNewline(addFileLines, addHasContent), null, null));
        }

        return operations;
    }

    /**
     * Append an update operation if old != new (mirrors flushUpdate in the JS parser).
     */
    private static void buildUpdateOperation(List<PatchOperation> operations, String path,
                                             StringBuilder oldLines, StringBuilder newLines,
                                             boolean oldHasContent, boolean newHasContent,
                                             int[] hunkHeader) {
        String oldString = stripTrailingNewline(oldLines, oldHasContent);
        String newString = stripTrailingNewline(newLines, newHasContent);
        if (oldString.equals(newString)) {
            return;
        }

        Integer startLine = null;
        Integer endLine = null;
        if (hunkHeader != null) {
            int oldCount = hunkHeader[1];
            int newCount = hunkHeader[3];
            int start = oldCount > 0 ? hunkHeader[0] : hunkHeader[2];
            int effectiveCount = oldCount > 0 ? oldCount : newCount;
            startLine = start;
            if (effectiveCount > 1) {
                endLine = start + effectiveCount - 1;
            }
        }

        operations.add(new PatchOperation(path, "update", oldString, newString, startLine, endLine));
    }

    private static int[] parseHunkHeader(String line) {
        Matcher matcher = HUNK_HEADER.matcher(line);
        if (!matcher.find()) {
            return null;
        }
        return new int[]{
                Integer.parseInt(matcher.group(1)),
                matcher.group(2) != null ? Integer.parseInt(matcher.group(2)) : 1,
                Integer.parseInt(matcher.group(3)),
                matcher.group(4) != null ? Integer.parseInt(matcher.group(4)) : 1,
        };
    }

    private static void appendLine(StringBuilder builder, String content) {
        if (builder.length() > 0) {
            builder.append('\n');
        }
        builder.append(content);
    }

    private static String stripTrailingNewline(StringBuilder builder, boolean hasContent) {
        return hasContent ? builder.toString() : "";
    }
}
