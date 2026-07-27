package com.codeaide.service;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Verifies that raw assistant protocol envelopes (thinking blocks, JSON-escaped
 * text) are reduced to clean commit text and never leak into the commit box.
 */
public class GitCommitMessageServiceExtractionTest {

    private static final String THINKING_ENVELOPE =
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
                    + "[{\"type\":\"thinking\",\"thinking\":\"let me analyze the diff\"}]}}";

    private static final String TEXT_ENVELOPE =
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
                    + "[{\"type\":\"text\",\"text\":\"\\u003ccommit\\u003e\\n"
                    + "refactor(channels): 将 SDK 描述迁移至渠道注册表\\n\\u003c/commit\\u003e\"}]}}";

    @Test
    public void shouldSkipThinkingOnlyAssistantEnvelopes() {
        GitCommitMessageService.CommitMessageCollector collector =
                new GitCommitMessageService.CommitMessageCollector();

        assertFalse(collector.onMessage("assistant", THINKING_ENVELOPE));
        assertEquals("", collector.collected());
    }

    @Test
    public void shouldExtractTextBlocksFromAssistantEnvelopes() {
        GitCommitMessageService.CommitMessageCollector collector =
                new GitCommitMessageService.CommitMessageCollector();

        assertTrue(collector.onMessage("assistant", TEXT_ENVELOPE));

        String collected = collector.collected();
        assertTrue(collected.contains("<commit>"));
        assertTrue(collected.contains("refactor(channels): 将 SDK 描述迁移至渠道注册表"));
        assertFalse(collected.contains("{"));
    }

    @Test
    public void shouldExtractPrimitiveContentFromAssistantEnvelopes() {
        GitCommitMessageService.CommitMessageCollector collector =
                new GitCommitMessageService.CommitMessageCollector();

        assertTrue(collector.onMessage("assistant",
                "{\"type\":\"assistant\",\"message\":{\"content\":\"plain codex text\"}}"));
        assertEquals("plain codex text", collector.collected());
    }

    @Test
    public void shouldIgnoreNonTextPayloads() {
        GitCommitMessageService.CommitMessageCollector collector =
                new GitCommitMessageService.CommitMessageCollector();

        assertFalse(collector.onMessage("thinking", "some reasoning"));
        assertFalse(collector.onMessage("assistant", "not json at all"));
        assertFalse(collector.onMessage("status", "working"));
        assertTrue(collector.onMessage("content", "real text"));
        assertEquals("real text", collector.collected());
    }

    @Test
    public void shouldRecoverCommitFromRawProtocolDump() {
        // The exact failure seen in production: raw envelopes (thinking + escaped
        // text) dumped as the generation result.
        String rawDump = THINKING_ENVELOPE + TEXT_ENVELOPE;

        String cleaned = GitCommitMessageService.cleanupCommitMessage(rawDump);

        assertTrue(cleaned.startsWith("refactor(channels): 将 SDK 描述迁移至渠道注册表"));
        assertFalse(cleaned.contains("thinking"));
        assertFalse(cleaned.contains("{"));
    }

    @Test
    public void shouldKeepPlainTaggedMessagesIntact() {
        String cleaned = GitCommitMessageService.cleanupCommitMessage(
                "<commit>\nfix(ui): 修复按钮错位\n</commit>");

        assertEquals("fix(ui): 修复按钮错位", cleaned);
    }
}
