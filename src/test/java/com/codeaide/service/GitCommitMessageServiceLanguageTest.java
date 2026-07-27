package com.codeaide.service;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.changes.Change;
import org.junit.Test;

import java.util.Collections;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Verifies that the commit-message prompt requires the output language
 * configured in the plugin settings (manual override or IDE language).
 */
public class GitCommitMessageServiceLanguageTest {

    @Test
    public void shouldRequireSimplifiedChineseWhenLanguageIsZh() {
        String prompt = capturePrompt("zh");

        assertTrue(prompt.contains("必须使用 Simplified Chinese (简体中文) 撰写"));
        assertFalse(prompt.contains("语言默认使用英文"));
    }

    @Test
    public void shouldRequireTraditionalChineseWhenLanguageIsZhTw() {
        String prompt = capturePrompt("zh-TW");

        assertTrue(prompt.contains("必须使用 Traditional Chinese (繁體中文) 撰写"));
    }

    @Test
    public void shouldRequireEnglishWhenLanguageIsEn() {
        String prompt = capturePrompt("en");

        assertTrue(prompt.contains("必须使用 English 撰写"));
    }

    @Test
    public void shouldKeepConventionalCommitTypeInEnglishRegardlessOfLanguage() {
        String prompt = capturePrompt("ja");

        assertTrue(prompt.contains("必须使用 Japanese (日本語) 撰写"));
        assertTrue(prompt.contains("type 和 scope 保持使用英文 Conventional Commits 关键字"));
    }

    private String capturePrompt(String language) {
        TestableGitCommitMessageService service = new TestableGitCommitMessageService(language);
        ResultCapture callback = new ResultCapture();

        service.generateCommitMessage(Collections.<Change>emptyList(), callback);

        assertNotNull("prompt should reach the Claude API call", service.lastPrompt);
        return service.lastPrompt;
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
        private String success;
        private String error;

        @Override
        public void onSuccess(String commitMessage) {
            this.success = commitMessage;
        }

        @Override
        public void onError(String error) {
            this.error = error;
        }
    }

    private static class TestableGitCommitMessageService extends GitCommitMessageService {
        private final String language;
        private String lastPrompt;

        private TestableGitCommitMessageService(String language) {
            super((Project) null);
            this.language = language;
        }

        @Override
        protected String getCommitOutputLanguage() {
            return language;
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
            this.lastPrompt = prompt;
            callback.onSuccess("fix: captured prompt");
        }

        @Override
        protected void callCodexAPI(String prompt, String model, CommitMessageCallback callback) {
            callback.onError("unexpected codex routing");
        }
    }
}
