package com.codeaide.provider.codex;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class CodexConfigTomlRewriterTest {

    private static final String CHAT_CONFIG = "disable_response_storage = true\n"
            + "model = \"kimi-k3\"\n"
            + "model_provider = \"kimi\"\n"
            + "\n"
            + "[model_providers.kimi]\n"
            + "name = \"kimi\"\n"
            + "base_url = \"https://api.kimi.com/coding/v1\"\n"
            + "requires_openai_auth = true\n"
            + "wire_api = \"chat\"\n";

    private static final String RESPONSES_CONFIG = CHAT_CONFIG.replace("wire_api = \"chat\"",
            "wire_api = \"responses\"");

    // ==================== needsConversion ====================

    @Test
    public void chatWireApiNeedsConversion() {
        assertTrue(CodexConfigTomlRewriter.needsConversion(CHAT_CONFIG));
    }

    @Test
    public void responsesWireApiDoesNotNeedConversion() {
        assertFalse(CodexConfigTomlRewriter.needsConversion(RESPONSES_CONFIG));
    }

    @Test
    public void commentedChatWireApiDoesNotNeedConversion() {
        String config = RESPONSES_CONFIG + "# wire_api = \"chat\"\n";
        assertFalse(CodexConfigTomlRewriter.needsConversion(config));
    }

    @Test
    public void nullConfigDoesNotNeedConversion() {
        assertFalse(CodexConfigTomlRewriter.needsConversion(null));
    }

    // ==================== extractBaseUrl ====================

    @Test
    public void extractsFirstNonCommentBaseUrl() {
        assertEquals("https://api.kimi.com/coding/v1",
                CodexConfigTomlRewriter.extractBaseUrl(CHAT_CONFIG));
    }

    @Test
    public void skipsCommentedBaseUrl() {
        String config = "# base_url = \"https://commented.example.com/v1\"\n"
                + "base_url = \"https://real.example.com/v1\"\n";
        assertEquals("https://real.example.com/v1", CodexConfigTomlRewriter.extractBaseUrl(config));
    }

    @Test
    public void returnsNullWhenNoBaseUrl() {
        assertNull(CodexConfigTomlRewriter.extractBaseUrl("model = \"gpt-5\"\n"));
        assertNull(CodexConfigTomlRewriter.extractBaseUrl(null));
    }

    // ==================== rewriteForProxy ====================

    @Test
    public void rewritesWireApiAndBaseUrl() {
        String rewritten = CodexConfigTomlRewriter.rewriteForProxy(
                CHAT_CONFIG, "http://127.0.0.1:54321/v1");

        String expected = CHAT_CONFIG
                .replace("base_url = \"https://api.kimi.com/coding/v1\"",
                        "base_url = \"http://127.0.0.1:54321/v1\"")
                .replace("wire_api = \"chat\"", "wire_api = \"responses\"");
        assertEquals(expected, rewritten);
    }

    @Test
    public void rewritePreservesCommentsAndTrailingCommentOnWireApiLine() {
        String config = "# wire_api = \"chat\"\n"
                + "wire_api = \"chat\" # upstream only supports chat\n"
                + "base_url = \"https://api.example.com/v1\"\r\n";
        String rewritten = CodexConfigTomlRewriter.rewriteForProxy(config, "http://127.0.0.1:1/v1");

        String[] lines = rewritten.split("\n", -1);
        assertEquals("# wire_api = \"chat\"", lines[0]);
        assertEquals("wire_api = \"responses\" # upstream only supports chat", lines[1]);
        assertEquals("base_url = \"http://127.0.0.1:1/v1\"\r", lines[2]);
    }

    @Test
    public void rewriteOnlyTouchesFirstBaseUrl() {
        String config = "base_url = \"https://one.example.com/v1\"\n"
                + "wire_api = \"chat\"\n"
                + "base_url = \"https://two.example.com/v1\"\n";
        String rewritten = CodexConfigTomlRewriter.rewriteForProxy(config, "http://127.0.0.1:1/v1");

        assertTrue(rewritten.contains("base_url = \"http://127.0.0.1:1/v1\""));
        assertTrue(rewritten.contains("base_url = \"https://two.example.com/v1\""));
    }

    @Test
    public void rewriteWithNullArgumentsReturnsInput() {
        assertEquals(CHAT_CONFIG, CodexConfigTomlRewriter.rewriteForProxy(CHAT_CONFIG, null));
        assertNull(CodexConfigTomlRewriter.rewriteForProxy(null, "http://127.0.0.1:1/v1"));
    }
}
