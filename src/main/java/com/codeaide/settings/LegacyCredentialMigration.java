package com.codeaide.settings;

import com.codeaide.bridge.NodeDetector;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * One-time migration for Phase 5c (plugin-owned credential storage).
 *
 * Earlier versions stored managed-provider credentials in the official CLI files
 * (~/.claude/settings.json, ~/.codex/config.toml, ~/.codex/auth.json) and MCP
 * servers in ~/.claude.json. This migration copies that state into the
 * plugin-owned locations (~/.codeaide/config.json provider entries,
 * ~/.codeaide/codex-home/, ~/.codeaide/mcp.json) on first startup.
 *
 * Rules:
 * - Never deletes or modifies the original official files (import-only).
 * - Idempotent: once the codeaide copy exists, the migration is a no-op.
 */
public final class LegacyCredentialMigration {
    private static final Logger LOG = Logger.getInstance(LegacyCredentialMigration.class);
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final AtomicBoolean ATTEMPTED = new AtomicBoolean(false);

    private LegacyCredentialMigration() {
    }

    /**
     * Production hook: run the migration at most once per JVM.
     * Failures are logged and never block startup.
     */
    public static void runIfNeeded(CodeaideSettingsService service) {
        if (!ATTEMPTED.compareAndSet(false, true)) {
            return;
        }
        try {
            runNow(service);
        } catch (Exception e) {
            LOG.warn("[Migration] Legacy credential migration failed: " + e.getMessage());
        }
    }

    /**
     * Unguarded migration run (idempotent). Exposed for tests.
     */
    public static void runNow(CodeaideSettingsService service) throws IOException {
        migrateClaudeProviderCredentials(service);
        migrateCodexHome(service);
        migrateMcpServers(service);
    }

    /**
     * Claude: if the active managed provider has no credentials in its codeaide
     * settingsConfig but ~/.claude/settings.json has them (synced there by an
     * older plugin version), import the provider-managed fields into codeaide.
     */
    private static void migrateClaudeProviderCredentials(CodeaideSettingsService service) throws IOException {
        JsonObject config = service.readConfig();
        if (!config.has("claude") || !config.get("claude").isJsonObject()) {
            return;
        }
        JsonObject claude = config.getAsJsonObject("claude");
        String currentId = claude.has("current") && !claude.get("current").isJsonNull()
                ? claude.get("current").getAsString().trim()
                : "";
        if (currentId.isEmpty()
                || ProviderManager.LOCAL_SETTINGS_PROVIDER_ID.equals(currentId)
                || ProviderManager.CLI_LOGIN_PROVIDER_ID.equals(currentId)) {
            return;
        }
        if (!claude.has("providers") || !claude.get("providers").isJsonObject()) {
            return;
        }
        JsonObject providers = claude.getAsJsonObject("providers");
        if (!providers.has(currentId) || !providers.get(currentId).isJsonObject()) {
            return;
        }

        JsonObject provider = providers.getAsJsonObject(currentId);
        JsonObject settingsConfig = provider.has("settingsConfig") && provider.get("settingsConfig").isJsonObject()
                ? provider.getAsJsonObject("settingsConfig")
                : new JsonObject();
        JsonObject env = settingsConfig.has("env") && settingsConfig.get("env").isJsonObject()
                ? settingsConfig.getAsJsonObject("env")
                : new JsonObject();

        // Idempotency: credentials already live in codeaide.
        if (hasNonBlank(env, "ANTHROPIC_AUTH_TOKEN") || hasNonBlank(env, "ANTHROPIC_API_KEY")) {
            return;
        }

        JsonObject claudeSettings = service.readClaudeSettings();
        if (!claudeSettings.has("env") || !claudeSettings.get("env").isJsonObject()) {
            return;
        }
        JsonObject diskEnv = claudeSettings.getAsJsonObject("env");
        if (!hasNonBlank(diskEnv, "ANTHROPIC_AUTH_TOKEN") && !hasNonBlank(diskEnv, "ANTHROPIC_API_KEY")) {
            return;
        }

        // Import provider-managed fields the provider entry is missing (env merged
        // key-by-key so codeaide values always win on conflict).
        for (String key : ClaudeSettingsManager.PROVIDER_MANAGED_FIELDS) {
            if ("codeaideProviderId".equals(key) || "ccSwitchProviderId".equals(key) || "env".equals(key)) {
                continue;
            }
            if (!settingsConfig.has(key) && claudeSettings.has(key) && !claudeSettings.get(key).isJsonNull()) {
                settingsConfig.add(key, claudeSettings.get(key));
            }
        }
        for (String envKey : diskEnv.keySet()) {
            // A blank value in codeaide is not a credential — treat it as absent
            // so the legacy value gets imported. Non-blank codeaide values win.
            if (!hasNonBlank(env, envKey) && !diskEnv.get(envKey).isJsonNull()) {
                env.add(envKey, diskEnv.get(envKey));
            }
        }
        settingsConfig.add("env", env);
        provider.add("settingsConfig", settingsConfig);

        service.writeConfig(config);
        LOG.info("[Migration] Imported Claude credentials for provider '" + currentId
                + "' from ~/.claude/settings.json into ~/.codeaide/config.json (original file kept)");
    }

    /**
     * Codex: materialize the isolated CODEX_HOME (~/.codeaide/codex-home) for a
     * managed provider. Credentials come from the provider entry (configToml /
     * authJson) when present, otherwise they are copied from the official
     * ~/.codex files (which are never deleted).
     */
    private static void migrateCodexHome(CodeaideSettingsService service) throws IOException {
        String accessMode;
        try {
            accessMode = service.getCodexRuntimeAccessMode();
        } catch (Exception e) {
            LOG.debug("[Migration] Could not resolve Codex access mode: " + e.getMessage());
            return;
        }
        if (!CodeaideSettingsService.CODEX_RUNTIME_ACCESS_MANAGED.equals(accessMode)) {
            return;
        }

        CodexSettingsManager.ensureIsolatedCodexHome();

        String userHome = NodeDetector.resolveHomeForFileOps();
        Path isolatedDir = Paths.get(userHome, ".codeaide", "codex-home");
        Path realCodexDir = Paths.get(userHome, ".codex");

        JsonObject activeProvider = service.getActiveCodexProvider();
        CodexSettingsManager codexSettingsManager = service.getCodexSettingsManager();

        // config.toml
        Path isolatedConfigToml = isolatedDir.resolve("config.toml");
        if (!Files.exists(isolatedConfigToml)) {
            String configToml = activeProvider != null
                    && activeProvider.has("configToml") && activeProvider.get("configToml").isJsonPrimitive()
                    ? activeProvider.get("configToml").getAsString()
                    : null;
            if (configToml != null && !configToml.trim().isEmpty()) {
                codexSettingsManager.writeConfigTomlRaw(configToml);
                LOG.info("[Migration] Materialized isolated Codex config.toml from provider entry");
            } else {
                Path realConfigToml = realCodexDir.resolve("config.toml");
                if (Files.exists(realConfigToml)) {
                    Files.copy(realConfigToml, isolatedConfigToml);
                    LOG.info("[Migration] Copied ~/.codex/config.toml into isolated CODEX_HOME (original kept)");
                }
            }
        }

        // auth.json
        Path isolatedAuthJson = isolatedDir.resolve("auth.json");
        if (!Files.exists(isolatedAuthJson)) {
            String authJson = activeProvider != null
                    && activeProvider.has("authJson") && activeProvider.get("authJson").isJsonPrimitive()
                    ? activeProvider.get("authJson").getAsString()
                    : null;
            boolean written = false;
            if (authJson != null && !authJson.trim().isEmpty()) {
                try {
                    codexSettingsManager.writeAuthJson(
                            com.google.gson.JsonParser.parseString(authJson).getAsJsonObject());
                    written = true;
                    LOG.info("[Migration] Materialized isolated Codex auth.json from provider entry");
                } catch (Exception e) {
                    LOG.warn("[Migration] Failed to parse provider authJson, falling back to file copy: "
                            + e.getMessage());
                }
            }
            if (!written) {
                Path realAuthJson = realCodexDir.resolve("auth.json");
                if (Files.exists(realAuthJson)) {
                    Files.copy(realAuthJson, isolatedAuthJson);
                    LOG.info("[Migration] Copied ~/.codex/auth.json into isolated CODEX_HOME (original kept)");
                }
            }
        }
    }

    /**
     * MCP: import ~/.claude.json MCP configuration into the plugin-owned
     * ~/.codeaide/mcp.json (first run only; the original file is kept).
     */
    private static void migrateMcpServers(CodeaideSettingsService service) {
        try {
            String userHome = NodeDetector.resolveHomeForFileOps();
            Path mcpJsonPath = Paths.get(userHome, ".codeaide", "mcp.json");
            if (Files.exists(mcpJsonPath)) {
                return;
            }

            Path claudeJsonPath = Paths.get(userHome, ".claude.json");
            if (!Files.exists(claudeJsonPath)) {
                return;
            }

            JsonObject claudeJson;
            try {
                String content = Files.readString(claudeJsonPath, StandardCharsets.UTF_8);
                claudeJson = com.google.gson.JsonParser.parseString(content).getAsJsonObject();
            } catch (Exception e) {
                LOG.warn("[Migration] Failed to parse ~/.claude.json, skipping MCP import: " + e.getMessage());
                return;
            }

            boolean hasMcp = claudeJson.has("mcpServers") && claudeJson.get("mcpServers").isJsonObject()
                    && claudeJson.getAsJsonObject("mcpServers").size() > 0;
            boolean hasDisabled = claudeJson.has("disabledMcpServers")
                    && claudeJson.get("disabledMcpServers").isJsonArray()
                    && claudeJson.getAsJsonArray("disabledMcpServers").size() > 0;
            if (!hasMcp && !hasDisabled) {
                return;
            }

            JsonObject mcpConfig = new JsonObject();
            if (claudeJson.has("mcpServers") && claudeJson.get("mcpServers").isJsonObject()) {
                mcpConfig.add("mcpServers", claudeJson.getAsJsonObject("mcpServers"));
            }
            if (claudeJson.has("disabledMcpServers") && claudeJson.get("disabledMcpServers").isJsonArray()) {
                mcpConfig.add("disabledMcpServers", claudeJson.getAsJsonArray("disabledMcpServers"));
            }

            // Import project-level MCP configuration (only the MCP keys, not the
            // rest of the CLI's per-project state).
            if (claudeJson.has("projects") && claudeJson.get("projects").isJsonObject()) {
                JsonObject projects = claudeJson.getAsJsonObject("projects");
                JsonObject importedProjects = new JsonObject();
                for (String projectPath : projects.keySet()) {
                    if (!projects.get(projectPath).isJsonObject()) {
                        continue;
                    }
                    JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                    JsonObject importedProject = new JsonObject();
                    if (projectConfig.has("mcpServers") && projectConfig.get("mcpServers").isJsonObject()) {
                        importedProject.add("mcpServers", projectConfig.getAsJsonObject("mcpServers"));
                    }
                    if (projectConfig.has("disabledMcpServers")
                            && projectConfig.get("disabledMcpServers").isJsonArray()) {
                        importedProject.add("disabledMcpServers", projectConfig.getAsJsonArray("disabledMcpServers"));
                    }
                    if (importedProject.size() > 0) {
                        importedProjects.add(projectPath, importedProject);
                    }
                }
                if (importedProjects.size() > 0) {
                    mcpConfig.add("projects", importedProjects);
                }
            }

            Files.createDirectories(mcpJsonPath.getParent());
            try (Writer writer = Files.newBufferedWriter(mcpJsonPath, StandardCharsets.UTF_8)) {
                GSON.toJson(mcpConfig, writer);
            }
            hardenFilePermissions(mcpJsonPath);
            LOG.info("[Migration] Imported MCP configuration from ~/.claude.json into "
                    + mcpJsonPath + " (original file kept)");
        } catch (Exception e) {
            LOG.warn("[Migration] Failed to import MCP configuration: " + e.getMessage());
        }
    }

    private static boolean hasNonBlank(JsonObject obj, String key) {
        return obj.has(key) && !obj.get(key).isJsonNull()
                && obj.get(key).isJsonPrimitive()
                && !obj.get(key).getAsString().isEmpty();
    }

    /**
     * Best-effort restrict a file to owner read/write (0600). No-op on non-POSIX
     * filesystems (e.g. Windows), where the per-user home directory ACL applies.
     */
    private static void hardenFilePermissions(Path path) {
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException e) {
            LOG.debug("[Migration] Could not set 0600 on " + path + ": " + e.getMessage());
        }
    }
}
