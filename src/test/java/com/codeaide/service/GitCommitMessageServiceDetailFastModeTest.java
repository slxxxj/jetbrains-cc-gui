package com.codeaide.service;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.changes.Change;
import org.junit.Test;

import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Verifies the per-file change detail section appended to the commit message
 * and the fast-mode (no-thinking) wiring.
 */
public class GitCommitMessageServiceDetailFastModeTest {

    @Test
    public void shouldCountLineChanges() {
        assertArrayEquals(new int[]{2, 0},
                GitCommitMessageService.countLineChanges("a\nb", "a\nb\nc\nd"));
        assertArrayEquals(new int[]{0, 1},
                GitCommitMessageService.countLineChanges("a\nb\nc", "a\nb"));
        assertArrayEquals(new int[]{1, 1},
                GitCommitMessageService.countLineChanges("a\nb\nc", "a\nx\nc"));
        assertArrayEquals(new int[]{0, 0},
                GitCommitMessageService.countLineChanges("same", "same"));
    }

    @Test
    public void shouldAppendFileDetailWhenEnabled() throws Exception {
        TestableService service = new TestableService(true, true);
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.singletonList(null), callback);

        assertTrue(callback.latch.await(5, TimeUnit.SECONDS));
        assertNull(callback.error);
        assertTrue(callback.success.startsWith("refactor(core): summary"));
        assertTrue(callback.success.contains("## Changed Files (2)"));
        assertTrue(callback.success.contains("M  src/A.java (+2/-1)"));
        assertTrue(callback.success.contains("A  src/B.java (+30)"));
    }

    @Test
    public void shouldOmitFileDetailWhenDisabled() throws Exception {
        TestableService service = new TestableService(false, true);
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.singletonList(null), callback);

        assertTrue(callback.latch.await(5, TimeUnit.SECONDS));
        assertEquals("refactor(core): summary", callback.success);
        assertFalse(callback.success.contains("Changed Files"));
    }

    @Test
    public void shouldUseLowReasoningEffortInFastMode() {
        assertEquals("low", new TestableService(true, true).getCodexReasoningEffort());
        assertNull(new TestableService(true, false).getCodexReasoningEffort());
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

    private static class TestableService extends GitCommitMessageService {
        private final boolean includeFileDetail;
        private final boolean fastMode;

        TestableService(boolean includeFileDetail, boolean fastMode) {
            super((Project) null);
            this.includeFileDetail = includeFileDetail;
            this.fastMode = fastMode;
        }

        @Override
        protected boolean isCommitIncludeFileDetail() {
            return includeFileDetail;
        }

        @Override
        protected boolean isCommitFastMode() {
            return fastMode;
        }

        @Override
        protected String getCommitOutputLanguage() {
            return "en";
        }

        @Override
        protected List<String> buildChangeInventory(List<Change> changes) {
            return List.of("M  src/A.java (+2/-1)", "A  src/B.java (+30)");
        }

        @Override
        protected String generateGitDiff(java.util.Collection<Change> changes) {
            return "diff";
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
            callback.onSuccess("refactor(core): summary");
        }

        @Override
        protected void callCodexAPI(String prompt, String model, CommitMessageCallback callback) {
            callback.onError("unexpected codex routing");
        }
    }
}
