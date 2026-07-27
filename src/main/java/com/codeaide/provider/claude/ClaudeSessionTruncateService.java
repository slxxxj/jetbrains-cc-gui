package com.codeaide.provider.claude;

import com.codeaide.bridge.NodeDetector;
import com.codeaide.util.PathUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Truncates and deletes Claude SDK JSONL session files for the message-level
 * recall feature (distinct from file rewind, which never touches history).
 *
 * Layout: ~/.claude/projects/&lt;sanitized-cwd&gt;/&lt;sessionId&gt;.jsonl, one JSON entry per
 * line, append-only and therefore chronological. Truncating at the line that
 * carries the target user-message uuid removes that message and everything
 * after it, including sidechain (subagent) entries appended later.
 */
public final class ClaudeSessionTruncateService {

    private static final Logger LOG = Logger.getInstance(ClaudeSessionTruncateService.class);

    // Same guard as HistoryDeleteService: reject path-traversal payloads before Path.resolve.
    private static final Pattern SESSION_ID_PATTERN = Pattern.compile("^[A-Za-z0-9._-]+$");

    private ClaudeSessionTruncateService() {
    }

    public static boolean isValidSessionId(String sessionId) {
        return sessionId != null && SESSION_ID_PATTERN.matcher(sessionId).matches();
    }

    /**
     * Result of a truncation: how many lines were kept / removed.
     */
    public static final class TruncateResult {
        public final int keptLines;
        public final int removedLines;

        TruncateResult(int keptLines, int removedLines) {
            this.keptLines = keptLines;
            this.removedLines = removedLines;
        }
    }

    /**
     * Resolve the main JSONL file for a session, with an out-of-bounds guard.
     *
     * @return the session file path, or null when inputs are invalid or the
     * resolved path escapes the project session directory
     */
    public static Path resolveSessionFile(String projectPath, String sessionId) {
        if (!isValidSessionId(sessionId) || projectPath == null || projectPath.isEmpty()) {
            return null;
        }
        String homeDir = NodeDetector.resolveHomeForFileOps();
        Path sessionDir = Paths.get(homeDir, ".claude", "projects", PathUtils.sanitizePath(projectPath));
        Path sessionFile = sessionDir.resolve(sessionId + ".jsonl").normalize();
        if (!sessionFile.startsWith(sessionDir.normalize())) {
            LOG.warn("[Recall] Refused out-of-bounds path: " + sessionFile);
            return null;
        }
        return sessionFile;
    }

    /**
     * Truncate the session file so it ends right BEFORE the entry carrying the
     * target uuid (that user message and everything after it is dropped).
     * The write is staged through a temp file and moved atomically where the
     * filesystem supports it.
     *
     * @throws IOException       on read/write failure
     * @throws IllegalArgumentException when the uuid is not found in the file
     */
    public static TruncateResult truncateBeforeMessage(Path sessionFile, String userMessageUuid) throws IOException {
        List<String> lines;
        try (BufferedReader reader = Files.newBufferedReader(sessionFile, StandardCharsets.UTF_8)) {
            lines = reader.lines().collect(Collectors.toList());
        }
        long sizeAtRead = Files.size(sessionFile);

        int targetIndex = -1;
        for (int i = 0; i < lines.size(); i++) {
            if (userMessageUuid.equals(extractUuid(lines.get(i)))) {
                targetIndex = i;
                break;
            }
        }
        if (targetIndex < 0) {
            throw new IllegalArgumentException("Message " + userMessageUuid + " not found in " + sessionFile.getFileName());
        }

        List<String> kept = new ArrayList<>(lines.subList(0, targetIndex));
        Path tempFile = sessionFile.resolveSibling(sessionFile.getFileName() + ".truncate-tmp");
        try {
            // Remove any leftover from a previously interrupted truncation.
            Files.deleteIfExists(tempFile);
            Files.write(tempFile, kept, StandardCharsets.UTF_8);
            moveWithAppendGuard(sessionFile, tempFile, sizeAtRead);
        } catch (Exception failure) {
            // Never leave a stale temp file behind on failure.
            Files.deleteIfExists(tempFile);
            throw failure;
        }

        int removed = lines.size() - targetIndex;
        LOG.info("[Recall] Truncated " + sessionFile.getFileName() + ": kept " + kept.size() + ", removed " + removed);
        return new TruncateResult(kept.size(), removed);
    }

    /**
     * Move the staged temp file over the session file, atomically where
     * supported. Before each attempt, verify the session file has not grown
     * since it was read: if the SDK appended lines in the read->replace
     * window, replacing the file would silently drop them, so fail instead.
     */
    private static void moveWithAppendGuard(Path sessionFile, Path tempFile, long sizeAtRead) throws IOException {
        ensureSessionFileUnchanged(sessionFile, sizeAtRead);
        try {
            Files.move(tempFile, sessionFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception atomicFailure) {
            ensureSessionFileUnchanged(sessionFile, sizeAtRead);
            Files.move(tempFile, sessionFile, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static void ensureSessionFileUnchanged(Path sessionFile, long sizeAtRead) throws IOException {
        if (Files.size(sessionFile) != sizeAtRead) {
            throw new IOException("Session file changed during truncation, aborting to avoid data loss");
        }
    }

    /**
     * Delete the session file and its related agent-*.jsonl sidechain files
     * (used when the very first user message is recalled, leaving nothing).
     *
     * @return number of files deleted (main + agent files)
     */
    public static int deleteSessionWithAgents(String projectPath, String sessionId) throws IOException {
        Path sessionFile = resolveSessionFile(projectPath, sessionId);
        if (sessionFile == null) {
            return 0;
        }
        Path sessionDir = sessionFile.getParent();
        int deleted = 0;

        if (Files.deleteIfExists(sessionFile)) {
            LOG.info("[Recall] Deleted session file: " + sessionFile.getFileName());
            deleted++;
        }

        if (Files.isDirectory(sessionDir)) {
            List<Path> agentFiles;
            try (Stream<Path> stream = Files.list(sessionDir)) {
                agentFiles = stream
                        .filter(path -> {
                            String name = path.getFileName().toString();
                            return name.startsWith("agent-") && name.endsWith(".jsonl")
                                    && isAgentFileRelatedToSession(path, sessionId);
                        })
                        .collect(Collectors.toList());
            }
            for (Path agentFile : agentFiles) {
                try {
                    Files.delete(agentFile);
                    deleted++;
                } catch (Exception e) {
                    LOG.warn("[Recall] Failed to delete agent file " + agentFile.getFileName() + ": " + e.getMessage());
                }
            }
        }
        return deleted;
    }

    /** Extract the top-level "uuid" field of a JSONL entry, or null. */
    static String extractUuid(String line) {
        try {
            JsonObject obj = JsonParser.parseString(line).getAsJsonObject();
            return obj.has("uuid") && !obj.get("uuid").isJsonNull() ? obj.get("uuid").getAsString() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isAgentFileRelatedToSession(Path agentFilePath, String sessionId) {
        try (BufferedReader reader = Files.newBufferedReader(agentFilePath, StandardCharsets.UTF_8)) {
            String line;
            int lineCount = 0;
            while ((line = reader.readLine()) != null && lineCount < 20) {
                if (line.contains("\"sessionId\":\"" + sessionId + "\"")
                        || line.contains("\"parentSessionId\":\"" + sessionId + "\"")) {
                    return true;
                }
                lineCount++;
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }
}
