package com.codeaide.provider.claude;

import org.junit.Assert;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Unit tests for {@link ClaudeSessionTruncateService}.
 */
public class ClaudeSessionTruncateServiceTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private Path writeSessionFile(String... lines) throws Exception {
        Path file = tempFolder.newFile("session-test.jsonl").toPath();
        Files.write(file, List.of(lines), StandardCharsets.UTF_8);
        return file;
    }

    private static String entry(String uuid) {
        return "{\"type\":\"user\",\"uuid\":\"" + uuid + "\"}";
    }

    private static Path tempSibling(Path sessionFile) {
        return sessionFile.resolveSibling(sessionFile.getFileName() + ".truncate-tmp");
    }

    @Test
    public void truncateRemovesTargetAndEverythingAfter() throws Exception {
        Path file = writeSessionFile(
            "{\"type\":\"summary\",\"summary\":\"s\"}",
            entry("u1"),
            "{\"type\":\"assistant\",\"uuid\":\"a1\"}",
            entry("u2"),
            "{\"type\":\"assistant\",\"uuid\":\"a2\"}",
            entry("u3"),
            "{\"type\":\"assistant\",\"uuid\":\"a3\"}"
        );

        ClaudeSessionTruncateService.TruncateResult result =
            ClaudeSessionTruncateService.truncateBeforeMessage(file, "u2");

        Assert.assertEquals(3, result.keptLines);
        Assert.assertEquals(4, result.removedLines);

        List<String> remaining = Files.readAllLines(file, StandardCharsets.UTF_8);
        Assert.assertEquals(3, remaining.size());
        Assert.assertEquals("u1", ClaudeSessionTruncateService.extractUuid(remaining.get(1)));
        Assert.assertEquals("a1", ClaudeSessionTruncateService.extractUuid(remaining.get(2)));
    }

    @Test
    public void truncateFirstMessageEmptiesFile() throws Exception {
        Path file = writeSessionFile(entry("u1"), entry("u2"));

        ClaudeSessionTruncateService.TruncateResult result =
            ClaudeSessionTruncateService.truncateBeforeMessage(file, "u1");

        Assert.assertEquals(0, result.keptLines);
        Assert.assertEquals(2, result.removedLines);
        Assert.assertEquals(0, Files.readAllLines(file, StandardCharsets.UTF_8).size());
    }

    @Test
    public void truncateUnknownUuidThrowsAndKeepsFileUntouched() throws Exception {
        Path file = writeSessionFile(entry("u1"), entry("u2"));

        try {
            ClaudeSessionTruncateService.truncateBeforeMessage(file, "missing");
            Assert.fail("Expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            // expected
        }

        Assert.assertEquals(2, Files.readAllLines(file, StandardCharsets.UTF_8).size());
        Assert.assertFalse("failure path must not leave a staged temp file", Files.exists(tempSibling(file)));
    }

    @Test
    public void truncateUsesFirstOccurrenceOfUuid() throws Exception {
        Path file = writeSessionFile(entry("u1"), entry("u2"), entry("u2"));

        ClaudeSessionTruncateService.TruncateResult result =
            ClaudeSessionTruncateService.truncateBeforeMessage(file, "u2");

        Assert.assertEquals(1, result.keptLines);
        Assert.assertEquals(2, result.removedLines);
    }

    @Test
    public void extractUuidToleratesGarbageLines() {
        Assert.assertNull(ClaudeSessionTruncateService.extractUuid("not json"));
        Assert.assertNull(ClaudeSessionTruncateService.extractUuid("{\"type\":\"summary\"}"));
        Assert.assertEquals("x", ClaudeSessionTruncateService.extractUuid("{\"uuid\":\"x\"}"));
    }

    @Test
    public void staleTempFileIsDiscardedAndTruncationSucceeds() throws Exception {
        Path file = writeSessionFile(entry("u1"), entry("u2"), entry("u3"));
        Path tempFile = tempSibling(file);
        Files.write(tempFile, List.of("junk from an interrupted run"), StandardCharsets.UTF_8);

        ClaudeSessionTruncateService.TruncateResult result =
            ClaudeSessionTruncateService.truncateBeforeMessage(file, "u2");

        Assert.assertEquals(1, result.keptLines);
        Assert.assertEquals(2, result.removedLines);
        Assert.assertEquals(List.of(entry("u1")), Files.readAllLines(file, StandardCharsets.UTF_8));
        Assert.assertFalse("staged temp file must not remain", Files.exists(tempFile));
    }

    /**
     * The append guard (moveWithAppendGuard) keeps a concurrent SDK append from being
     * silently dropped: if the session file grows between the initial read and the staged
     * replace, truncation must fail with "Session file changed during truncation" and
     * leave the original file in place.
     *
     * There is no deterministic seam between the read and the move, so this test drives
     * the race for real: a writer thread appends sentinel lines in a tight loop while the
     * main thread truncates a large session file (large enough that the staged temp write
     * keeps the read-to-replace window open for several milliseconds). Whichever way the
     * race resolves, the file must end up coherent — never a truncated prefix silently
     * covering up lost appends — and no .truncate-tmp file may be left behind. The loop
     * repeats until the guard has been observed firing at least once.
     */
    @Test(timeout = 60000)
    public void concurrentAppendDuringTruncationNeverLosesData() throws Exception {
        final int lineCount = 20_000;
        final int targetIndex = lineCount / 2;
        final String pad = "x".repeat(150);
        int guardHits = 0;

        for (int iteration = 0; iteration < 30 && guardHits == 0; iteration++) {
            List<String> lines = new ArrayList<>(lineCount);
            for (int i = 0; i < lineCount; i++) {
                String uuid = i == targetIndex ? "target" : "u" + i;
                lines.add("{\"type\":\"user\",\"uuid\":\"" + uuid + "\",\"pad\":\"" + pad + "\"}");
            }
            Path file = tempFolder.newFile().toPath();
            Files.write(file, lines, StandardCharsets.UTF_8);

            AtomicBoolean stop = new AtomicBoolean();
            AtomicInteger appended = new AtomicInteger();
            AtomicReference<Throwable> appendFailure = new AtomicReference<>();
            Thread appender = new Thread(() -> {
                while (!stop.get()) {
                    try {
                        Files.write(file,
                            List.of("{\"type\":\"assistant\",\"uuid\":\"append-" + appended.get() + "\"}"),
                            StandardCharsets.UTF_8, StandardOpenOption.APPEND);
                        appended.incrementAndGet();
                    } catch (Throwable t) {
                        appendFailure.compareAndSet(null, t);
                        return;
                    }
                }
            });
            appender.setDaemon(true);
            appender.start();
            // Give the appender a head start so appends interleave with the truncation.
            long deadline = System.currentTimeMillis() + 5000;
            while (appended.get() == 0 && System.currentTimeMillis() < deadline) {
                Thread.sleep(1);
            }

            IOException guardFailure = null;
            try {
                ClaudeSessionTruncateService.truncateBeforeMessage(file, "target");
            } catch (IOException e) {
                if (e.getMessage() != null && e.getMessage().contains("changed during truncation")) {
                    guardFailure = e;
                } else {
                    throw e;
                }
            } finally {
                stop.set(true);
                appender.join(5000);
            }

            Assert.assertFalse("staged temp file must not remain", Files.exists(tempSibling(file)));

            List<String> finalLines = Files.readAllLines(file, StandardCharsets.UTF_8);
            if (guardFailure != null) {
                guardHits++;
                // Aborted truncation: the original file was left in place, so every
                // original line is still there (appends only ever went to the end).
                Assert.assertTrue(finalLines.size() >= lineCount);
                for (int i = 0; i < lineCount; i++) {
                    Assert.assertEquals(lines.get(i), finalLines.get(i));
                }
            } else {
                // Successful truncation: exactly the kept prefix, plus any appends that
                // landed after the replace. The target and everything after it is gone.
                Assert.assertTrue(finalLines.size() >= targetIndex);
                for (int i = 0; i < targetIndex; i++) {
                    Assert.assertEquals(lines.get(i), finalLines.get(i));
                }
                for (int i = targetIndex; i < finalLines.size(); i++) {
                    Assert.assertTrue("only concurrent appends may follow the kept prefix",
                        finalLines.get(i).contains("\"append-"));
                }
            }
        }

        Assert.assertTrue("append guard should have fired at least once within 30 iterations",
            guardHits > 0);
    }

    @Test
    public void sessionIdValidationRejectsTraversal() {
        Assert.assertFalse(ClaudeSessionTruncateService.isValidSessionId("../evil"));
        Assert.assertFalse(ClaudeSessionTruncateService.isValidSessionId("a/b"));
        Assert.assertFalse(ClaudeSessionTruncateService.isValidSessionId(null));
        Assert.assertFalse(ClaudeSessionTruncateService.isValidSessionId(""));
        Assert.assertTrue(ClaudeSessionTruncateService.isValidSessionId("0f8e7d6c-1234-5678-9abc-def012345678"));
        Assert.assertTrue(ClaudeSessionTruncateService.isValidSessionId("abc.DEF_123-xyz"));
    }
}
