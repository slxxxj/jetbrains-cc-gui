package com.codeaide.service;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.changes.Change;
import org.junit.Test;

import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Verifies the commit message generation timeout guard: the UI callback must
 * fire even when the underlying provider never responds (wedged daemon request,
 * stalled child process), and the delegate must see exactly one callback.
 */
public class GitCommitMessageServiceTimeoutTest {

    @Test
    public void shouldFailWithTimeoutWhenProviderNeverResponds() throws Exception {
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(200);
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertTrue("timeout should deliver an error", callback.latch.await(5, TimeUnit.SECONDS));
        assertNull(callback.success);
        assertEquals("Generation timed out. Please try again", callback.error);
    }

    @Test
    public void shouldRunTimeoutCleanupWhenTimeoutFires() throws Exception {
        CountDownLatch cleanupLatch = new CountDownLatch(1);
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(200) {
            @Override
            protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
                ((GitCommitMessageService.TimeoutGuard) callback).addTimeoutCleanup(cleanupLatch::countDown);
                // Never responds, simulating a wedged provider.
            }
        };
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertTrue(callback.latch.await(5, TimeUnit.SECONDS));
        assertTrue("timeout cleanup should run", cleanupLatch.await(5, TimeUnit.SECONDS));
    }

    @Test
    public void shouldDeliverOnlyTheFirstCallback() throws Exception {
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(60_000) {
            @Override
            protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
                callback.onError("boom");
                callback.onSuccess("fix: late success");
            }
        };
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertTrue(callback.latch.await(5, TimeUnit.SECONDS));
        assertEquals("boom", callback.error);
        assertNull(callback.success);
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
            // Never responds, simulating a wedged provider.
        }

        @Override
        protected void callCodexAPI(String prompt, String model, CommitMessageCallback callback) {
            callback.onError("unexpected codex routing");
        }
    }
}
