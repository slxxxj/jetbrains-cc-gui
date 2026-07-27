package com.codeaide.service;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.changes.Change;
import org.junit.Test;

import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Verifies stage progress reporting and user cancellation of commit message
 * generation, so the UI can show what is happening instead of a static
 * "generating..." placeholder.
 */
public class GitCommitMessageServiceProgressTest {

    @Test
    public void shouldReportStagesWhileGenerating() {
        List<String> stages = new CopyOnWriteArrayList<>();
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(60_000);
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback, stages::add);

        assertTrue(stages.contains("Collecting changes…"));
        assertTrue(stages.contains("Connecting to AI service…"));
    }

    @Test
    public void shouldDeliverCancellationExactlyOnceAndRunCleanup() throws Exception {
        CountDownLatch cleanupLatch = new CountDownLatch(1);
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(60_000) {
            @Override
            protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
                ((GitCommitMessageService.TimeoutGuard) callback).addTimeoutCleanup(cleanupLatch::countDown);
                // Never responds, waiting to be cancelled.
            }
        };
        ResultCapture callback = new ResultCapture();

        GitCommitMessageService.GenerationHandle handle =
                service.generateCommitMessage(Collections.<Change>emptyList(), callback, stage -> { });

        handle.cancel();
        handle.cancel(); // must be idempotent

        assertTrue(callback.latch.await(5, TimeUnit.SECONDS));
        assertEquals("Generation cancelled", callback.error);
        assertNull(callback.success);
        assertTrue("cancellation should run the channel cleanup", cleanupLatch.await(5, TimeUnit.SECONDS));
    }

    private static JsonObject buildClaudeConfig() {
        JsonObject config = new JsonObject();
        config.add("provider", JsonNull.INSTANCE);
        config.addProperty("effectiveProvider", "claude");
        config.addProperty("resolutionSource", "auto");

        JsonObject models = new JsonObject();
        models.addProperty("claude", "claude-sonnet-4-6");
        models.addProperty("codex", "gpt-5.5");
        config.add("models", models);
        return config;
    }

    private static class ResultCapture implements GitCommitMessageService.CommitMessageCallback {
        private final CountDownLatch latch = new CountDownLatch(1);
        private volatile String success;
        private volatile String error;

        @Override
        public void onSuccess(String commitMessage) {
            this.success = commitMessage;
            latch.countDown();
        }

        @Override
        public void onError(String error) {
            this.error = error;
            latch.countDown();
        }
    }

    private static class TestableGitCommitMessageService extends GitCommitMessageService {
        private final long timeoutMs;

        private TestableGitCommitMessageService(long timeoutMs) {
            super((Project) null);
            this.timeoutMs = timeoutMs;
        }

        @Override
        protected long getGenerationTimeoutMs() {
            return timeoutMs;
        }

        @Override
        protected String getCommitOutputLanguage() {
            return "en";
        }

        @Override
        protected String generateGitDiff(java.util.Collection<Change> changes) {
            return "diff";
        }

        @Override
        protected JsonObject getCommitAiConfig() {
            return buildClaudeConfig();
        }

        @Override
        protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
            // Never responds, simulating a slow provider.
        }

        @Override
        protected void callCodexAPI(String prompt, String model, CommitMessageCallback callback) {
            callback.onError("unexpected codex routing");
        }
    }
}
