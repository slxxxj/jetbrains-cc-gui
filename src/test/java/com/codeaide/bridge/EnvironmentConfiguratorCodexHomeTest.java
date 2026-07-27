package com.codeaide.bridge;

import com.codeaide.settings.CodeaideSettingsService;
import com.codeaide.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;

import static org.junit.Assert.assertTrue;

/**
 * Phase 5c tests for CODEX_HOME routing in {@link EnvironmentConfigurator}:
 * managed/inactive Codex modes get the plugin-owned isolated CODEX_HOME
 * (~/.codeaide/codex-home); __codex_cli_login__ keeps the real ~/.codex.
 */
public class EnvironmentConfiguratorCodexHomeTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void managedModePointsCodexHomeAtIsolatedDir() throws Exception {
        Path tempHome = Files.createTempDirectory("env-config-managed-home");
        useTemporaryHomeDirectory(tempHome);
        writeCodeaideConfig(tempHome, "provider-a", false);

        Map<String, String> env = runConfigurator();

        assertTrue("CODEX_HOME must point at the isolated dir, got: " + env.get("CODEX_HOME"),
                normalize(env.get("CODEX_HOME")).endsWith("/.codeaide/codex-home"));
    }

    @Test
    public void inactiveModeAlsoPointsCodexHomeAtIsolatedDir() throws Exception {
        Path tempHome = Files.createTempDirectory("env-config-inactive-home");
        useTemporaryHomeDirectory(tempHome);
        writeCodeaideConfig(tempHome, "", false);

        Map<String, String> env = runConfigurator();

        assertTrue("CODEX_HOME must point at the isolated dir, got: " + env.get("CODEX_HOME"),
                normalize(env.get("CODEX_HOME")).endsWith("/.codeaide/codex-home"));
    }

    @Test
    public void cliLoginModeKeepsRealCodexDir() throws Exception {
        Path tempHome = Files.createTempDirectory("env-config-cli-login-home");
        useTemporaryHomeDirectory(tempHome);
        writeCodeaideConfig(tempHome, "__codex_cli_login__", true);

        Map<String, String> env = runConfigurator();

        String codexHome = normalize(env.get("CODEX_HOME"));
        assertTrue("CODEX_HOME must stay on the real ~/.codex, got: " + codexHome,
                codexHome.endsWith("/.codex"));
    }

    private Map<String, String> runConfigurator() {
        EnvironmentConfigurator configurator = new EnvironmentConfigurator(new CodeaideSettingsService());
        ProcessBuilder pb = new ProcessBuilder("node", "--version");
        configurator.updateProcessEnvironment(pb, "node");
        return new TreeMap<>(pb.environment());
    }

    private static String normalize(String path) {
        return path == null ? "" : path.replace('\\', '/');
    }

    private static void writeCodeaideConfig(Path tempHome, String current, boolean authorized)
            throws Exception {
        Path codeaideDir = tempHome.resolve(".codeaide");
        Files.createDirectories(codeaideDir);
        JsonObject providers = new JsonObject();
        if (!current.isEmpty() && !"__codex_cli_login__".equals(current)) {
            JsonObject provider = new JsonObject();
            provider.addProperty("name", "Provider A");
            providers.add(current, provider);
        }
        JsonObject codex = new JsonObject();
        codex.addProperty("current", current);
        codex.addProperty("localConfigAuthorized", authorized);
        codex.add("providers", providers);
        JsonObject config = new JsonObject();
        config.addProperty("version", 2);
        config.add("codex", codex);
        Files.writeString(codeaideDir.resolve("config.json"), config.toString(), StandardCharsets.UTF_8);
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
