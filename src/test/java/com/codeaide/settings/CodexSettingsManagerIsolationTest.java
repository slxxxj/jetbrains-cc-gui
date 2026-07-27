package com.codeaide.settings;

import com.codeaide.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
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
 * Phase 5c tests for {@link CodexSettingsManager}: managed providers use the
 * isolated CODEX_HOME (~/.codeaide/codex-home), while __codex_cli_login__ keeps
 * targeting the real ~/.codex directory.
 */
public class CodexSettingsManagerIsolationTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void managedModeRoutesWritesToIsolatedCodexHome() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-isolated-home");
        useTemporaryHomeDirectory(tempHome);
        writeCodeaideConfig(tempHome, "provider-a", false);

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());

        assertEquals(tempHome.resolve(".codeaide").resolve("codex-home"),
                manager.resolveEffectiveCodexDir());
        assertEquals(tempHome.resolve(".codeaide").resolve("codex-home").resolve("config.toml"),
                manager.getConfigTomlPath());
        assertEquals(tempHome.resolve(".codeaide").resolve("codex-home").resolve("auth.json"),
                manager.getAuthJsonPath());

        // Apply a managed provider: files land in the isolated home only
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "provider-a");
        provider.addProperty("configToml", "model = \"gpt-5\"\n");
        provider.addProperty("authJson", "{\"OPENAI_API_KEY\":\"sk-test\"}");
        manager.applyProviderToCodexSettings(provider);

        Path isolatedConfigToml = tempHome.resolve(".codeaide").resolve("codex-home").resolve("config.toml");
        Path isolatedAuthJson = tempHome.resolve(".codeaide").resolve("codex-home").resolve("auth.json");
        assertTrue(Files.exists(isolatedConfigToml));
        assertTrue(Files.exists(isolatedAuthJson));
        assertEquals("model = \"gpt-5\"\n", Files.readString(isolatedConfigToml, StandardCharsets.UTF_8));
        assertFalse("official ~/.codex must not be written in managed mode",
                Files.exists(tempHome.resolve(".codex").resolve("config.toml")));
        assertFalse("official ~/.codex must not be written in managed mode",
                Files.exists(tempHome.resolve(".codex").resolve("auth.json")));
    }

    @Test
    public void cliLoginModeKeepsTargetingRealCodexDir() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-cli-login-home");
        useTemporaryHomeDirectory(tempHome);
        writeCodeaideConfig(tempHome, CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID, true);

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());

        assertEquals(tempHome.resolve(".codex"), manager.resolveEffectiveCodexDir());
        assertEquals(tempHome.resolve(".codex").resolve("config.toml"), manager.getConfigTomlPath());
        assertEquals(tempHome.resolve(".codex").resolve("auth.json"), manager.getAuthJsonPath());
    }

    @Test
    public void cliLoginAvailabilityAlwaysReadsRealCodexDir() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-cli-availability-home");
        useTemporaryHomeDirectory(tempHome);
        // Managed mode active — but CLI login availability must still check ~/.codex
        writeCodeaideConfig(tempHome, "provider-a", false);

        Files.createDirectories(tempHome.resolve(".codex"));
        Files.writeString(
                tempHome.resolve(".codex").resolve("auth.json"),
                "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"token-value\"}}",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        assertTrue(manager.isCodexCliLoginAvailable());

        // Tokens placed only in the isolated home must NOT count as CLI login
        Files.delete(tempHome.resolve(".codex").resolve("auth.json"));
        Path isolatedDir = tempHome.resolve(".codeaide").resolve("codex-home");
        Files.createDirectories(isolatedDir);
        Files.writeString(
                isolatedDir.resolve("auth.json"),
                "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"token-value\"}}",
                StandardCharsets.UTF_8
        );
        assertFalse(manager.isCodexCliLoginAvailable());
    }

    @Test
    public void ensureIsolatedCodexHomeCreatesDirAndSessionsLink() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-isolated-sessions-home");
        useTemporaryHomeDirectory(tempHome);

        CodexSettingsManager.ensureIsolatedCodexHome();

        Path isolatedDir = tempHome.resolve(".codeaide").resolve("codex-home");
        Path linkedSessions = isolatedDir.resolve("sessions");
        Path realSessions = tempHome.resolve(".codex").resolve("sessions");

        assertTrue(Files.exists(isolatedDir));

        // Symlinks and Windows junctions both resolve to the link target via
        // toRealPath(); a plain directory (link creation failed) does not.
        boolean linked = Files.exists(linkedSessions) && Files.exists(realSessions)
                && linkedSessions.toRealPath().equals(realSessions.toRealPath());
        if (linked) {
            // Session history converges to the official directory through the link
            Path probe = linkedSessions.resolve("probe.jsonl");
            Files.writeString(probe, "{}", StandardCharsets.UTF_8);
            assertTrue("writes through the link land in ~/.codex/sessions",
                    Files.exists(realSessions.resolve("probe.jsonl")));
        } else {
            // Filesystem cannot create links (e.g. restricted Windows) — the
            // isolated home still works, sessions just stay isolated (logged).
            System.out.println("[CodexSettingsManagerIsolationTest] sessions link unavailable, "
                    + "skipping link-through assertion");
        }
    }

    @Test
    public void ensureIsolatedCodexHomeSkipsSessionsLinkWhenIsolationEnabled() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-isolated-sessions-strict-home");
        useTemporaryHomeDirectory(tempHome);
        writeCodeaideConfigWithIsolation(tempHome, true);

        CodexSettingsManager.ensureIsolatedCodexHome();

        Path isolatedDir = tempHome.resolve(".codeaide").resolve("codex-home");
        assertTrue("isolated CODEX_HOME must still be created", Files.exists(isolatedDir));
        assertFalse("no sessions link/directory may be created when isolation is enabled",
                Files.exists(isolatedDir.resolve("sessions")));
        assertFalse("the official ~/.codex must stay untouched when isolation is enabled",
                Files.exists(tempHome.resolve(".codex")));
    }

    @Test
    public void ensureIsolatedCodexHomePreservesExistingSessionsEntryWhenIsolationEnabled() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-isolated-sessions-preserve-home");
        useTemporaryHomeDirectory(tempHome);

        // Pre-existing state: sessions entry already present (link when the
        // filesystem allows it, otherwise a real directory with data inside).
        Path isolatedDir = tempHome.resolve(".codeaide").resolve("codex-home");
        Path realSessions = tempHome.resolve(".codex").resolve("sessions");
        Path sessionsEntry = isolatedDir.resolve("sessions");
        Files.createDirectories(isolatedDir);
        Files.createDirectories(realSessions);
        boolean linked = false;
        try {
            Files.createSymbolicLink(sessionsEntry, realSessions);
            linked = true;
        } catch (Exception e) {
            // Link unsupported (e.g. Windows without symlink privilege): fall back
            // to a real directory — the non-destructive assertion still applies.
            Files.createDirectories(sessionsEntry);
        }
        Path marker = linked ? realSessions.resolve("keep.jsonl") : sessionsEntry.resolve("keep.jsonl");
        Files.writeString(marker, "{}", StandardCharsets.UTF_8);

        writeCodeaideConfigWithIsolation(tempHome, true);
        CodexSettingsManager.ensureIsolatedCodexHome();

        // Non-destructive guarantee: the existing entry and its data survive.
        assertTrue("existing sessions entry must never be deleted", Files.exists(sessionsEntry));
        assertTrue("session data must never be deleted", Files.exists(marker));
        if (linked) {
            assertEquals("existing link must keep pointing at ~/.codex/sessions",
                    realSessions.toRealPath(), sessionsEntry.toRealPath());
        }
    }

    @Test
    public void isSessionsIsolationEnabledReadsCodexSectionFlag() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-isolate-flag-home");
        Path configPath = tempHome.resolve(".codeaide").resolve("config.json");

        // Missing file -> default false (shared-history behavior).
        assertFalse(CodexSettingsManager.isSessionsIsolationEnabled(configPath));

        Files.createDirectories(configPath.getParent());

        // Flag absent -> false.
        Files.writeString(configPath, "{\"version\":2,\"codex\":{\"current\":\"\",\"providers\":{}}}",
                StandardCharsets.UTF_8);
        assertFalse(CodexSettingsManager.isSessionsIsolationEnabled(configPath));

        // Flag explicitly false -> false.
        Files.writeString(configPath, "{\"version\":2,\"codex\":{\"isolateSessions\":false}}",
                StandardCharsets.UTF_8);
        assertFalse(CodexSettingsManager.isSessionsIsolationEnabled(configPath));

        // Flag true -> true.
        Files.writeString(configPath, "{\"version\":2,\"codex\":{\"isolateSessions\":true}}",
                StandardCharsets.UTF_8);
        assertTrue(CodexSettingsManager.isSessionsIsolationEnabled(configPath));

        // Malformed JSON -> best-effort false.
        Files.writeString(configPath, "not-json", StandardCharsets.UTF_8);
        assertFalse(CodexSettingsManager.isSessionsIsolationEnabled(configPath));
    }

    private static void writeCodeaideConfigWithIsolation(Path tempHome, boolean isolateSessions)
            throws Exception {
        Path codeaideDir = tempHome.resolve(".codeaide");
        Files.createDirectories(codeaideDir);
        String config = "{\"version\":2,\"codex\":{"
                + "\"current\":\"provider-a\","
                + "\"isolateSessions\":" + isolateSessions + ","
                + "\"providers\":{\"provider-a\":{\"name\":\"Provider A\"}}"
                + "}}";
        Files.writeString(codeaideDir.resolve("config.json"), config, StandardCharsets.UTF_8);
    }

    private static void writeCodeaideConfig(Path tempHome, String current, boolean authorized)
            throws Exception {
        Path codeaideDir = tempHome.resolve(".codeaide");
        Files.createDirectories(codeaideDir);
        String providers = CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID.equals(current)
                ? "{}"
                : "{\"" + current + "\":{\"name\":\"Provider A\"}}";
        String config = "{\"version\":2,\"codex\":{"
                + "\"current\":\"" + current + "\","
                + "\"localConfigAuthorized\":" + authorized + ","
                + "\"providers\":" + providers
                + "}}";
        Files.writeString(codeaideDir.resolve("config.json"), config, StandardCharsets.UTF_8);
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
