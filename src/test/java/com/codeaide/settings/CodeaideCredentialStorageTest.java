package com.codeaide.settings;

import com.codeaide.util.PlatformUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Phase 5c regression tests: provider management operations (add / switch /
 * thinking toggle / skills sync / MCP sync) must write the plugin-owned
 * codeaide files only and must never create or modify the official CLI files
 * (~/.claude/settings.json, ~/.claude.json).
 */
public class CodeaideCredentialStorageTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void managedProviderLifecycleNeverTouchesOfficialClaudeFiles() throws Exception {
        Path tempHome = Files.createTempDirectory("codeaide-storage-home");
        useTemporaryHomeDirectory(tempHome);
        Path claudeSettingsPath = tempHome.resolve(".claude").resolve("settings.json");
        Path claudeJsonPath = tempHome.resolve(".claude.json");

        CodeaideSettingsService service = new CodeaideSettingsService();

        // 1. Add + switch to a managed provider (credentials included)
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "provider-a");
        provider.addProperty("name", "Provider A");
        JsonObject settingsConfig = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "sk-ant-1234567890abcdef");
        env.addProperty("ANTHROPIC_BASE_URL", "https://provider-a.example.com");
        settingsConfig.add("env", env);
        provider.add("settingsConfig", settingsConfig);

        service.addClaudeProvider(provider);
        service.switchClaudeProvider("provider-a");

        assertFalse("settings.json must not be created on provider add/switch",
                Files.exists(claudeSettingsPath));

        // Credentials must be in the codeaide config
        JsonObject config = service.readConfig();
        JsonObject stored = config.getAsJsonObject("claude")
                .getAsJsonObject("providers")
                .getAsJsonObject("provider-a");
        assertEquals("sk-ant-1234567890abcdef",
                stored.getAsJsonObject("settingsConfig").getAsJsonObject("env")
                        .get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertEquals("provider-a", config.getAsJsonObject("claude").get("current").getAsString());

        // 2. Thinking toggle goes to the codeaide provider entry, not settings.json
        service.setAlwaysThinkingEnabledInClaudeSettings(false);
        service.setAlwaysThinkingEnabledInActiveProvider(false);
        assertFalse("settings.json must not be created by the thinking toggle",
                Files.exists(claudeSettingsPath));
        assertEquals(Boolean.FALSE, service.getAlwaysThinkingEnabledFromClaudeSettings());

        // 3. Current-config view comes from codeaide (masked, same shape as before)
        JsonObject currentConfig = service.getCurrentClaudeConfig();
        assertEquals("sk-a****cdef", currentConfig.get("apiKey").getAsString());
        assertEquals("auth_token", currentConfig.get("authType").getAsString());
        assertEquals("https://provider-a.example.com", currentConfig.get("baseUrl").getAsString());
        assertEquals("provider-a", currentConfig.get("providerId").getAsString());
        assertEquals("Provider A", currentConfig.get("providerName").getAsString());

        // 4. Skills sync is skipped for managed providers
        JsonObject skill = new JsonObject();
        skill.addProperty("id", "skill-a");
        skill.addProperty("name", "Skill A");
        skill.addProperty("path", "/tmp/skill-a");
        skill.addProperty("enabled", true);
        service.upsertSkill(skill);
        assertFalse("settings.json must not be created by skills sync",
                Files.exists(claudeSettingsPath));

        // 5. MCP upsert/delete goes to ~/.codeaide/mcp.json, never ~/.claude.json
        JsonObject server = new JsonObject();
        server.addProperty("id", "srv-a");
        server.addProperty("name", "srv-a");
        JsonObject serverSpec = new JsonObject();
        serverSpec.addProperty("type", "stdio");
        serverSpec.addProperty("command", "node");
        server.add("server", serverSpec);
        service.upsertMcpServer(server);

        Path mcpJsonPath = tempHome.resolve(".codeaide").resolve("mcp.json");
        assertTrue("MCP config must be written to ~/.codeaide/mcp.json", Files.exists(mcpJsonPath));
        assertFalse("~/.claude.json must not be created by MCP sync", Files.exists(claudeJsonPath));
        assertFalse("settings.json must not be created by MCP sync", Files.exists(claudeSettingsPath));

        JsonObject mcpConfig = JsonParser.parseString(
                Files.readString(mcpJsonPath, StandardCharsets.UTF_8)).getAsJsonObject();
        assertTrue(mcpConfig.getAsJsonObject("mcpServers").has("srv-a"));
        assertEquals(1, service.getMcpServers().size());

        assertTrue(service.deleteMcpServer("srv-a"));
        mcpConfig = JsonParser.parseString(
                Files.readString(mcpJsonPath, StandardCharsets.UTF_8)).getAsJsonObject();
        assertFalse(mcpConfig.getAsJsonObject("mcpServers").has("srv-a"));
        assertFalse(Files.exists(claudeJsonPath));
        assertFalse(Files.exists(claudeSettingsPath));
    }

    @Test
    public void mcpUpsertSeedsFromLegacyClaudeJsonWithoutModifyingIt() throws Exception {
        Path tempHome = Files.createTempDirectory("codeaide-mcp-seed-home");
        useTemporaryHomeDirectory(tempHome);

        // Legacy state: MCP servers only exist in ~/.claude.json
        Path claudeJsonPath = tempHome.resolve(".claude.json");
        String legacyContent = "{"
                + "\"mcpServers\":{\"legacy-srv\":{\"command\":\"node\",\"args\":[\"l.js\"]}},"
                + "\"oauthAccount\":{\"emailAddress\":\"u@example.com\"}"
                + "}";
        Files.writeString(claudeJsonPath, legacyContent, StandardCharsets.UTF_8);

        CodeaideSettingsService service = new CodeaideSettingsService();

        // Legacy servers are still visible (read-only fallback)
        assertEquals(1, service.getMcpServers().size());

        // First upsert seeds mcp.json from the legacy file, preserving existing servers
        JsonObject server = new JsonObject();
        server.addProperty("id", "new-srv");
        server.addProperty("name", "new-srv");
        JsonObject serverSpec = new JsonObject();
        serverSpec.addProperty("type", "http");
        serverSpec.addProperty("url", "http://localhost:8080");
        server.add("server", serverSpec);
        service.upsertMcpServer(server);

        Path mcpJsonPath = tempHome.resolve(".codeaide").resolve("mcp.json");
        JsonObject mcpConfig = JsonParser.parseString(
                Files.readString(mcpJsonPath, StandardCharsets.UTF_8)).getAsJsonObject();
        assertTrue("seeded from ~/.claude.json", mcpConfig.getAsJsonObject("mcpServers").has("legacy-srv"));
        assertTrue(mcpConfig.getAsJsonObject("mcpServers").has("new-srv"));
        assertFalse("non-MCP CLI state must not be copied", mcpConfig.has("oauthAccount"));

        // The legacy file is byte-for-byte intact
        assertEquals(legacyContent, Files.readString(claudeJsonPath, StandardCharsets.UTF_8));
        assertEquals(2, service.getMcpServers().size());
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}
