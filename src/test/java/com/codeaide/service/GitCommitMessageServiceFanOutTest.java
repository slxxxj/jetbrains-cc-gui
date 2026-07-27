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
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Verifies the fan-out generation for large change sets: per-batch parallel
 * summary agents, tolerance of partial batch failures, and a final merge
 * request aggregating the summaries.
 */
public class GitCommitMessageServiceFanOutTest {

    @Test
    public void shouldFanOutIntoPerBatchSummariesAndMerge() throws Exception {
        RecordingService service = new RecordingService(5, 4);
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(nChanges(12), callback);

        assertTrue(callback.latch.await(10, TimeUnit.SECONDS));
        assertNull(callback.error);
        assertEquals("refactor(core): merged result", callback.success);
        assertEquals(3, service.batchPrompts.size());
        assertEquals(1, service.mergePrompts.size());
        assertTrue(service.mergePrompts.get(0).contains("batch summary"));
        assertTrue(service.mergePrompts.get(0).contains("【第 3 批】"));
    }

    @Test
    public void shouldStaySingleRequestWhenChangeSetFitsOneBatch() throws Exception {
        RecordingService service = new RecordingService(5, 4);
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(nChanges(5), callback);

        assertTrue(callback.latch.await(10, TimeUnit.SECONDS));
        assertNull(callback.error);
        assertEquals(0, service.batchPrompts.size());
        assertEquals(1, service.mergePrompts.size());
    }

    @Test
    public void shouldToleratePartialBatchFailure() throws Exception {
        RecordingService service = new RecordingService(5, 4) {
            @Override
            protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
                if (prompt.contains("第 2 批的变更清单")) {
                    batchPrompts.add(prompt); // record the attempt before failing it
                    callback.onError("agent boom");
                    return;
                }
                super.callClaudeAPI(prompt, model, callback);
            }
        };
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(nChanges(12), callback);

        assertTrue(callback.latch.await(10, TimeUnit.SECONDS));
        assertNull(callback.error);
        assertEquals("refactor(core): merged result", callback.success);
        assertEquals(3, service.batchPrompts.size());
        // Only the two successful summaries reach the merge prompt
        assertTrue(service.mergePrompts.get(0).contains("【第 2 批】"));
        assertFalse(service.mergePrompts.get(0).contains("【第 3 批】"));
    }

    @Test
    public void shouldFailWhenAllBatchesFail() throws Exception {
        RecordingService service = new RecordingService(5, 4) {
            @Override
            protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
                if (prompt.contains("批的变更清单")) {
                    callback.onError("agent boom");
                    return;
                }
                super.callClaudeAPI(prompt, model, callback);
            }
        };
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(nChanges(12), callback);

        assertTrue(callback.latch.await(10, TimeUnit.SECONDS));
        assertNull(callback.success);
        assertEquals("Failed to call AI API", callback.error);
        assertTrue("merge request must not run when every batch failed", service.mergePrompts.isEmpty());
    }

    @Test
    public void shouldScaleFanOutTimeoutByWaves() {
        assertEquals(120_000, new RecordingService(5, 4).getGenerationTimeoutMs());
        assertEquals(135_000, GitCommitMessageService.computeFanOutTimeoutMs(3, 4));
        assertEquals(450_000, GitCommitMessageService.computeFanOutTimeoutMs(32, 4));
        assertEquals(600_000, GitCommitMessageService.computeFanOutTimeoutMs(1000, 1));
    }

    private static List<Change> nChanges(int n) {
        return Collections.nCopies(n, (Change) null);
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

    private static class RecordingService extends GitCommitMessageService {
        private final int batchSize;
        private final int maxParallel;
        final List<String> batchPrompts = new CopyOnWriteArrayList<>();
        final List<String> mergePrompts = new CopyOnWriteArrayList<>();
        private final AtomicInteger summaryCounter = new AtomicInteger(0);

        RecordingService(int batchSize, int maxParallel) {
            super((Project) null);
            this.batchSize = batchSize;
            this.maxParallel = maxParallel;
        }

        @Override
        protected int getCommitAgentBatchSize() {
            return batchSize;
        }

        @Override
        protected int getCommitAgentMaxParallel() {
            return maxParallel;
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
        protected List<String> buildChangeInventory(List<Change> changes) {
            List<String> inventory = new java.util.ArrayList<>(changes.size());
            for (int i = 0; i < changes.size(); i++) {
                inventory.add("M  src/File" + i + ".java (+1/-1)");
            }
            return inventory;
        }

        @Override
        protected boolean isCommitIncludeFileDetail() {
            return false;
        }

        @Override
        protected JsonObject getCommitAiConfig() {
            JsonObject config = new JsonObject();
            config.add("provider", JsonNull.INSTANCE);
            config.addProperty("effectiveProvider", "claude");
            JsonObject models = new JsonObject();
            models.addProperty("claude", "claude-sonnet-4-6");
            models.addProperty("codex", "gpt-5.5");
            config.add("models", models);
            return config;
        }

        @Override
        protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
            if (prompt.contains("批的变更清单")) {
                batchPrompts.add(prompt);
                callback.onSuccess("type: refactor\n- batch summary " + summaryCounter.incrementAndGet());
            } else {
                mergePrompts.add(prompt);
                callback.onSuccess("refactor(core): merged result");
            }
        }

        @Override
        protected void callCodexAPI(String prompt, String model, CommitMessageCallback callback) {
            callback.onError("unexpected codex routing");
        }
    }
}
