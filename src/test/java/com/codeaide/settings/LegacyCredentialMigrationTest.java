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
 * Tests for {@link LegacyCredentialMigration} (Phase 5c): credentials and MCP
 * config that older plugin versions stored in the official CLI files are
 * imported into the plugin-owned codeaide locations. The originals are never
 * deleted or modified, and the migration is idempotent.
 */
public class LegacyCredentialMigrationTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void claudeCredentialsAreImportedFromLegacySettingsJson() throws Exception {
        Path tempHome = Files.createTempDirectory("migration-claude-home");
        useTemporaryHomeDirectory(tempHome);

        // Legacy state: managed provider without credentials in codeaide; the
        // credentials only exist in ~/.claude/settings.json (synced by an old
        // plugin version).
        Path claudeDir = tempHome.resolve(".claude");
        Files.createDirectories(claudeDir);
        Path settingsPath = claudeDir.resolve("settings.json");
        String legacySettings = "{\"env\":{"
                + "\"ANTHROPIC_AUTH_TOKEN\":\"sk-ant-legacy-token\","
                + "\"ANTHROPIC_BASE_URL\":\"https://legacy.example.com\""
                + "},\"model\":\"claude-sonnet-4-6\",\"codeaideProviderId\":\"provider-a\"}";
        Files.writeString(settingsPath, legacySettings, StandardCharsets.UTF_8);

        CodeaideSettingsService service = new CodeaideSettingsService();
        writeClaudeProviderConfig(service, "", null);

        LegacyCredentialMigration.runNow(service);

        JsonObject config = service.readConfig();
        JsonObject settingsConfig = config.getAsJsonObject("claude")
                .getAsJsonObject("providers")
                .getAsJsonObject("provider-a")
                .getAsJsonObject("settingsConfig");
        JsonObject env = settingsConfig.getAsJsonObject("env");
        assertEquals("sk-ant-legacy-token", env.get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertEquals("https://legacy.example.com", env.get("ANTHROPIC_BASE_URL").getAsString());
        assertEquals("claude-sonnet-4-6", settingsConfig.get("model").getAsString());
        assertFalse("sync markers must not be imported", settingsConfig.has("codeaideProviderId"));

        // Original file untouched
        assertEquals(legacySettings, Files.readString(settingsPath, StandardCharsets.UTF_8));

        // Idempotent: second run is a no-op
        String configAfterFirstRun = readRawConfig(tempHome);
        LegacyCredentialMigration.runNow(service);
        assertEquals(configAfterFirstRun, readRawConfig(tempHome));
        assertEquals(legacySettings, Files.readString(settingsPath, StandardCharsets.UTF_8));
    }

    @Test
    public void claudeMigrationKeepsExistingCodeaideCredentials() throws Exception {
        Path tempHome = Files.createTempDirectory("migration-claude-keep-home");
        useTemporaryHomeDirectory(tempHome);

        Path claudeDir = tempHome.resolve(".claude");
        Files.createDirectories(claudeDir);
        Files.writeString(
                claudeDir.resolve("settings.json"),
                "{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"sk-ant-legacy-token\"}}",
                StandardCharsets.UTF_8
        );

        CodeaideSettingsService service = new CodeaideSettingsService();
        writeClaudeProviderConfig(service, "sk-ant-codeaide-token", null);

        LegacyCredentialMigration.runNow(service);

        JsonObject config = service.readConfig();
        JsonObject env = config.getAsJsonObject("claude")
                .getAsJsonObject("providers")
                .getAsJsonObject("provider-a")
                .getAsJsonObject("settingsConfig")
                .getAsJsonObject("env");
        assertEquals("codeaide credentials always win", "sk-ant-codeaide-token",
                env.get("ANTHROPIC_AUTH_TOKEN").getAsString());
    }

    @Test
    public void codexFilesAreCopiedIntoIsolatedHome() throws Exception {
        Path tempHome = Files.createTempDirectory("migration-codex-home");
        useTemporaryHomeDirectory(tempHome);

        // Legacy state: managed provider entry without configToml/authJson; the
        // effective config only exists in ~/.codex.
        Path realCodexDir = tempHome.resolve(".codex");
        Files.createDirectories(realCodexDir);
        String configToml = "model = \"gpt-5\"\n";
        String authJson = "{\"OPENAI_API_KEY\":\"sk-legacy\"}";
        Files.writeString(realCodexDir.resolve("config.toml"), configToml, StandardCharsets.UTF_8);
        Files.writeString(realCodexDir.resolve("auth.json"), authJson, StandardCharsets.UTF_8);

        CodeaideSettingsService service = new CodeaideSettingsService();
        writeCodexProviderConfig(service, null, null);

        LegacyCredentialMigration.runNow(service);

        Path isolatedDir = tempHome.resolve(".codeaide").resolve("codex-home");
        assertEquals(configToml,
                Files.readString(isolatedDir.resolve("config.toml"), StandardCharsets.UTF_8));
        assertEquals(authJson,
                Files.readString(isolatedDir.resolve("auth.json"), StandardCharsets.UTF_8));

        // Originals untouched
        assertEquals(configToml,
                Files.readString(realCodexDir.resolve("config.toml"), StandardCharsets.UTF_8));
        assertEquals(authJson,
                Files.readString(realCodexDir.resolve("auth.json"), StandardCharsets.UTF_8));

        // Idempotent: user edits in the isolated home are preserved on re-run
        String edited = "model = \"gpt-5.5\"\n";
        Files.writeString(isolatedDir.resolve("config.toml"), edited, StandardCharsets.UTF_8);
        LegacyCredentialMigration.runNow(service);
        assertEquals(edited,
                Files.readString(isolatedDir.resolve("config.toml"), StandardCharsets.UTF_8));
    }

    @Test
    public void codexProviderEntryWinsOverLegacyFiles() throws Exception {
        Path tempHome = Files.createTempDirectory("migration-codex-entry-home");
        useTemporaryHomeDirectory(tempHome);

        Path realCodexDir = tempHome.resolve(".codex");
        Files.createDirectories(realCodexDir);
        Files.writeString(realCodexDir.resolve("config.toml"), "model = \"gpt-4\"\n",
                StandardCharsets.UTF_8);

        CodeaideSettingsService service = new CodeaideSettingsService();
        writeCodexProviderConfig(service, "model = \"gpt-5\"\n", null);

        LegacyCredentialMigration.runNow(service);

        Path isolatedDir = tempHome.resolve(".codeaide").resolve("codex-home");
        assertEquals("provider entry is the source of truth for managed providers",
                "model = \"gpt-5\"\n",
                Files.readString(isolatedDir.resolve("config.toml"), StandardCharsets.UTF_8));
    }

    @Test
    public void mcpConfigIsImportedFromLegacyClaudeJson() throws Exception {
        Path tempHome = Files.createTempDirectory("migration-mcp-home");
        useTemporaryHomeDirectory(tempHome);

        Path claudeJsonPath = tempHome.resolve(".claude.json");
        String legacyClaudeJson = "{"
                + "\"mcpServers\":{\"srv\":{\"command\":\"node\",\"args\":[\"s.js\"]}},"
                + "\"disabledMcpServers\":[\"srv\"],"
                + "\"oauthAccount\":{\"emailAddress\":\"u@example.com\"},"
                + "\"projects\":{\"/proj/a\":{\"mcpServers\":{\"p-srv\":{\"url\":\"http://x\"}},\"history\":[]}}"
                + "}";
        Files.writeString(claudeJsonPath, legacyClaudeJson, StandardCharsets.UTF_8);

        CodeaideSettingsService service = new CodeaideSettingsService();

        LegacyCredentialMigration.runNow(service);

        Path mcpJsonPath = tempHome.resolve(".codeaide").resolve("mcp.json");
        assertTrue(Files.exists(mcpJsonPath));
        JsonObject mcpConfig = JsonParser.parseString(
                Files.readString(mcpJsonPath, StandardCharsets.UTF_8)).getAsJsonObject();
        assertTrue(mcpConfig.getAsJsonObject("mcpServers").has("srv"));
        assertEquals("srv", mcpConfig.getAsJsonArray("disabledMcpServers").get(0).getAsString());
        assertTrue(mcpConfig.getAsJsonObject("projects").getAsJsonObject("/proj/a")
                .getAsJsonObject("mcpServers").has("p-srv"));
        assertFalse("non-MCP CLI state must not be imported", mcpConfig.has("oauthAccount"));
        assertFalse("non-MCP project state must not be imported",
                mcpConfig.getAsJsonObject("projects").getAsJsonObject("/proj/a").has("history"));

        // Original untouched
        assertEquals(legacyClaudeJson, Files.readString(claudeJsonPath, StandardCharsets.UTF_8));

        // Idempotent: later edits to mcp.json are preserved on re-run
        String edited = "{\"mcpServers\":{\"edited\":{\"command\":\"node\"}}}";
        Files.writeString(mcpJsonPath, edited, StandardCharsets.UTF_8);
        LegacyCredentialMigration.runNow(service);
        assertEquals(edited, Files.readString(mcpJsonPath, StandardCharsets.UTF_8));
    }

    @Test
    public void migrationIsANoOpForCliLoginAndLocalModes() throws Exception {
        Path tempHome = Files.createTempDirectory("migration-cli-login-home");
        useTemporaryHomeDirectory(tempHome);

        Path claudeDir = tempHome.resolve(".claude");
        Files.createDirectories(claudeDir);
        Files.writeString(
                claudeDir.resolve("settings.json"),
                "{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"sk-ant-legacy-token\"}}",
                StandardCharsets.UTF_8
        );

        CodeaideSettingsService service = new CodeaideSettingsService();
        JsonObject config = service.readConfig();
        JsonObject claude = new JsonObject();
        claude.addProperty("current", ProviderManager.CLI_LOGIN_PROVIDER_ID);
        claude.add("providers", new JsonObject());
        config.add("claude", claude);
        service.writeConfig(config);

        LegacyCredentialMigration.runNow(service);

        // CLI login mode: credentials stay in the official files, codeaide is not polluted
        JsonObject after = service.readConfig();
        assertFalse(after.getAsJsonObject("claude").has("providers")
                && after.getAsJsonObject("claude").getAsJsonObject("providers").size() > 0);
        assertFalse(Files.exists(tempHome.resolve(".codeaide").resolve("codex-home").resolve("config.toml")));
    }

    private static void writeClaudeProviderConfig(CodeaideSettingsService service,
                                                  String authToken,
                                                  String baseUrl) throws Exception {
        JsonObject config = service.readConfig();
        JsonObject claude = new JsonObject();
        claude.addProperty("current", "provider-a");
        JsonObject providers = new JsonObject();
        JsonObject provider = new JsonObject();
        provider.addProperty("name", "Provider A");
        JsonObject settingsConfig = new JsonObject();
        if (authToken != null || baseUrl != null) {
            JsonObject env = new JsonObject();
            if (authToken != null) {
                env.addProperty("ANTHROPIC_AUTH_TOKEN", authToken);
            }
            if (baseUrl != null) {
                env.addProperty("ANTHROPIC_BASE_URL", baseUrl);
            }
            settingsConfig.add("env", env);
        }
        provider.add("settingsConfig", settingsConfig);
        providers.add("provider-a", provider);
        claude.add("providers", providers);
        config.add("claude", claude);
        service.writeConfig(config);
    }

    private static void writeCodexProviderConfig(CodeaideSettingsService service,
                                                 String configToml,
                                                 String authJson) throws Exception {
        JsonObject config = service.readConfig();
        JsonObject codex = new JsonObject();
        codex.addProperty("current", "provider-a");
        codex.addProperty("localConfigAuthorized", false);
        JsonObject providers = new JsonObject();
        JsonObject provider = new JsonObject();
        provider.addProperty("name", "Provider A");
        if (configToml != null) {
            provider.addProperty("configToml", configToml);
        }
        if (authJson != null) {
            provider.addProperty("authJson", authJson);
        }
        providers.add("provider-a", provider);
        codex.add("providers", providers);
        config.add("codex", codex);
        service.writeConfig(config);
    }

    private static String readRawConfig(Path tempHome) throws Exception {
        return Files.readString(tempHome.resolve(".codeaide").resolve("config.json"),
                StandardCharsets.UTF_8);
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
