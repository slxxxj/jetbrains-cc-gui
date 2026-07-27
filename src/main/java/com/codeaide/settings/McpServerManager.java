package com.codeaide.settings;

import com.codeaide.bridge.NodeDetector;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * MCP Server Manager.
 * Manages MCP server configurations.
 *
 * Phase 5c: the primary store is the plugin-owned ~/.codeaide/mcp.json (same
 * shape as the MCP subset of ~/.claude.json). ~/.claude.json is kept as a
 * read-only fallback for users who configure MCP via the official CLI; the
 * plugin no longer writes it.
 */
public class McpServerManager {
    private static final Logger LOG = Logger.getInstance(McpServerManager.class);

    private final Gson gson;
    private final Function<Void, JsonObject> configReader;
    private final java.util.function.Consumer<JsonObject> configWriter;

    public McpServerManager(
            Gson gson,
            Function<Void, JsonObject> configReader,
            java.util.function.Consumer<JsonObject> configWriter) {
        this.gson = gson;
        this.configReader = configReader;
        this.configWriter = configWriter;
    }

    /**
     * Path of the plugin-owned MCP configuration file (~/.codeaide/mcp.json).
     */
    private static Path getCodeaideMcpJsonPath() {
        String homeDir = NodeDetector.resolveHomeForFileOps();
        return Paths.get(homeDir, ".codeaide", "mcp.json");
    }

    /**
     * Path of the official Claude CLI file that historically held MCP config.
     * Read-only fallback; never written by the plugin.
     */
    private static Path getLegacyClaudeJsonPath() {
        String homeDir = NodeDetector.resolveHomeForFileOps();
        return Paths.get(homeDir, ".claude.json");
    }

    /**
     * Read a JSON object from disk, returning null when missing or unparseable.
     */
    private JsonObject readJsonObjectQuietly(Path path, String label) {
        File file = path.toFile();
        if (!file.exists()) {
            return null;
        }
        try (FileReader reader = new FileReader(file, StandardCharsets.UTF_8)) {
            return JsonParser.parseReader(reader).getAsJsonObject();
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Failed to read " + label + ": " + e.getMessage());
            return null;
        }
    }

    /**
     * Extract only the MCP-related keys (mcpServers / disabledMcpServers, plus
     * their per-project counterparts) from a ~/.claude.json-shaped object.
     */
    private static JsonObject extractMcpSubset(JsonObject source) {
        JsonObject subset = new JsonObject();
        if (source == null) {
            return subset;
        }
        if (source.has("mcpServers") && source.get("mcpServers").isJsonObject()) {
            subset.add("mcpServers", source.getAsJsonObject("mcpServers").deepCopy());
        }
        if (source.has("disabledMcpServers") && source.get("disabledMcpServers").isJsonArray()) {
            subset.add("disabledMcpServers", source.getAsJsonArray("disabledMcpServers").deepCopy());
        }
        if (source.has("projects") && source.get("projects").isJsonObject()) {
            JsonObject projects = source.getAsJsonObject("projects");
            JsonObject subsetProjects = new JsonObject();
            for (String projectPath : projects.keySet()) {
                if (!projects.get(projectPath).isJsonObject()) {
                    continue;
                }
                JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                JsonObject subsetProject = new JsonObject();
                if (projectConfig.has("mcpServers") && projectConfig.get("mcpServers").isJsonObject()) {
                    subsetProject.add("mcpServers", projectConfig.getAsJsonObject("mcpServers").deepCopy());
                }
                if (projectConfig.has("disabledMcpServers")
                        && projectConfig.get("disabledMcpServers").isJsonArray()) {
                    subsetProject.add("disabledMcpServers",
                            projectConfig.getAsJsonArray("disabledMcpServers").deepCopy());
                }
                if (subsetProject.size() > 0) {
                    subsetProjects.add(projectPath, subsetProject);
                }
            }
            if (subsetProjects.size() > 0) {
                subset.add("projects", subsetProjects);
            }
        }
        return subset;
    }

    /**
     * Load the effective MCP configuration object: the plugin-owned mcp.json when
     * present, otherwise the MCP subset imported (read-only) from ~/.claude.json.
     */
    private JsonObject loadEffectiveMcpConfig() {
        JsonObject codeaideMcp = readJsonObjectQuietly(getCodeaideMcpJsonPath(), "~/.codeaide/mcp.json");
        if (codeaideMcp != null) {
            return codeaideMcp;
        }
        JsonObject legacy = readJsonObjectQuietly(getLegacyClaudeJsonPath(), "~/.claude.json");
        return legacy != null ? extractMcpSubset(legacy) : null;
    }

    /**
     * Persist the plugin-owned MCP configuration file with owner-only permissions.
     */
    private void writeCodeaideMcpConfig(JsonObject mcpConfig) throws IOException {
        Path mcpJsonPath = getCodeaideMcpJsonPath();
        Files.createDirectories(mcpJsonPath.getParent());
        try (FileWriter writer = new FileWriter(mcpJsonPath.toFile(), StandardCharsets.UTF_8)) {
            gson.toJson(mcpConfig, writer);
            writer.flush();  // Ensure data is fully flushed to disk
        }
        // Security (J): mcp.json may hold MCP server env secrets; restrict to 0600.
        hardenFilePermissions(mcpJsonPath);
    }

    /**
     * Best-effort restrict a file to owner read/write (0600). No-op on non-POSIX
     * filesystems (e.g. Windows), where the per-user home directory ACL applies. (Security J)
     */
    private static void hardenFilePermissions(Path path) {
        try {
            Files.setPosixFilePermissions(path, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException e) {
            LOG.debug("[McpServerManager] Could not set 0600 on " + path + ": " + e.getMessage());
        }
    }

    /**
     * Get all MCP servers.
     * Reads the plugin-owned ~/.codeaide/mcp.json first, falling back to
     * ~/.claude.json (read-only), then to ~/.codeaide/config.json.
     * <p>
     * Note: Claude CLI merges global and project-level disabledMcpServers.
     */
    public List<JsonObject> getMcpServers() throws IOException {
        return getMcpServersWithProjectPath(null);
    }

    /**
     * Get all MCP servers (with project path support).
     * Merges global and project-level mcpServers; project-level servers override global ones with the same name.
     *
     * @param projectPath the project path, used to read project-level MCP configuration
     */
    public List<JsonObject> getMcpServersWithProjectPath(String projectPath) throws IOException {
        List<JsonObject> result = new ArrayList<>();

        // 1. Read the effective MCP config (codeaide mcp.json, else ~/.claude.json subset)
        JsonObject mcpConfig = loadEffectiveMcpConfig();
        if (mcpConfig != null && mcpConfig.has("mcpServers") && mcpConfig.get("mcpServers").isJsonObject()) {
            JsonObject globalMcpServers = mcpConfig.getAsJsonObject("mcpServers");

            // Merge global and project mcpServers (project config overrides servers with the same name)
            JsonObject mergedServers = new JsonObject();
            for (String key : globalMcpServers.keySet()) {
                mergedServers.add(key, globalMcpServers.get(key));
            }

            if (projectPath != null && mcpConfig.has("projects")) {
                JsonObject projects = mcpConfig.getAsJsonObject("projects");
                if (projects.has(projectPath)) {
                    JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                    if (projectConfig.has("mcpServers")
                                && projectConfig.get("mcpServers").isJsonObject()) {
                        JsonObject projectMcpServers = projectConfig.getAsJsonObject("mcpServers");
                        for (String key : projectMcpServers.keySet()) {
                            mergedServers.add(key, projectMcpServers.get(key));
                        }
                        LOG.info("[McpServerManager] Merged project-level MCP servers from: " + projectPath);
                    }
                }
            }

            // Read the globally disabled servers list
            Set<String> disabledServers = new HashSet<>();
            if (mcpConfig.has("disabledMcpServers") && mcpConfig.get("disabledMcpServers").isJsonArray()) {
                JsonArray disabledArray = mcpConfig.getAsJsonArray("disabledMcpServers");
                for (JsonElement elem : disabledArray) {
                    if (elem.isJsonPrimitive()) {
                        disabledServers.add(elem.getAsString());
                    }
                }
            }

            // Read project-level disabled servers list (if project path is provided)
            if (projectPath != null && mcpConfig.has("projects")) {
                JsonObject projects = mcpConfig.getAsJsonObject("projects");
                if (projects.has(projectPath)) {
                    JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                    if (projectConfig.has("disabledMcpServers")
                                && projectConfig.get("disabledMcpServers").isJsonArray()) {
                        JsonArray projectDisabledArray = projectConfig.getAsJsonArray("disabledMcpServers");
                        for (JsonElement elem : projectDisabledArray) {
                            if (elem.isJsonPrimitive()) {
                                disabledServers.add(elem.getAsString());
                            }
                        }
                        LOG.info("[McpServerManager] Merged project-level disabled servers from: " + projectPath);
                    }
                }
            }

            // Convert merged servers to list format
            for (String serverId : mergedServers.keySet()) {
                JsonElement serverElem = mergedServers.get(serverId);
                if (serverElem.isJsonObject()) {
                    JsonObject server = serverElem.getAsJsonObject();

                    // Ensure id and name fields exist
                    if (!server.has("id")) {
                        server.addProperty("id", serverId);
                    }
                    if (!server.has("name")) {
                        server.addProperty("name", serverId);
                    }

                    // Wrap type, command, args, env, etc. into the server field
                    if (!server.has("server")) {
                        JsonObject serverSpec = new JsonObject();

                        // Copy all fields to the server spec (except special fields)
                        Set<String> excludedFields = new HashSet<>();
                        excludedFields.add("id");
                        excludedFields.add("name");
                        excludedFields.add("enabled");
                        excludedFields.add("apps");
                        excludedFields.add("server");

                        for (String key : server.keySet()) {
                            if (!excludedFields.contains(key)) {
                                serverSpec.add(key, server.get(key));
                            }
                        }

                        server.add("server", serverSpec);
                    }

                    // Set enabled/disabled status (merging global and project levels)
                    boolean isEnabled = !disabledServers.contains(serverId);
                    server.addProperty("enabled", isEnabled);

                    result.add(server);
                }
            }

            LOG.info("[McpServerManager] Loaded " + result.size()
                             + " MCP servers from effective MCP config (disabled: " + disabledServers.size() + ")");
            return result;
        }

        // 2. Fall back to ~/.codeaide/config.json (array format)
        JsonObject config = configReader.apply(null);
        if (config.has("mcpServers")) {
            JsonArray servers = config.getAsJsonArray("mcpServers");
            for (JsonElement elem : servers) {
                if (elem.isJsonObject()) {
                    result.add(elem.getAsJsonObject());
                }
            }
        }

        LOG.info("[McpServerManager] Loaded " + result.size() + " MCP servers from ~/.codeaide/config.json");
        return result;
    }

    /**
     * Upsert (update or insert) an MCP server.
     * Writes to the plugin-owned ~/.codeaide/mcp.json (seeding it from the
     * effective config on first write so existing servers are preserved),
     * falling back to ~/.codeaide/config.json.
     */
    public void upsertMcpServer(JsonObject server) throws IOException {
        upsertMcpServer(server, null);
    }

    /**
     * Upsert (update or insert) an MCP server (with project path support).
     *
     * @param projectPath the project path, used to update project-level disabledMcpServers (Claude CLI merges global and project-level disabled lists)
     */
    public void upsertMcpServer(JsonObject server, String projectPath) throws IOException {
        if (!server.has("id")) {
            throw new IllegalArgumentException("Server must have an id");
        }

        String serverId = server.get("id").getAsString();
        boolean isEnabled = !server.has("enabled") || server.get("enabled").getAsBoolean();

        try {
            // Seed from the effective config so the first write preserves servers
            // that previously lived only in ~/.claude.json.
            JsonObject mcpConfig = loadEffectiveMcpConfig();
            if (mcpConfig == null) {
                mcpConfig = new JsonObject();
            }

            // Ensure mcpServers object exists
            if (!mcpConfig.has("mcpServers") || !mcpConfig.get("mcpServers").isJsonObject()) {
                mcpConfig.add("mcpServers", new JsonObject());
            }
            JsonObject mcpServers = mcpConfig.getAsJsonObject("mcpServers");

            // Extract server spec
            JsonObject serverSpec;
            if (server.has("server") && server.get("server").isJsonObject()) {
                serverSpec = server.getAsJsonObject("server").deepCopy();
            } else {
                serverSpec = new JsonObject();
            }

            // If the server already exists, merge with existing config (preserve fields not specified in new config)
            if (mcpServers.has(serverId) && mcpServers.get(serverId).isJsonObject()) {
                JsonObject existingSpec = mcpServers.getAsJsonObject(serverId).deepCopy();
                // Merge new config onto existing config (new values override matching fields)
                for (String key : serverSpec.keySet()) {
                    existingSpec.add(key, serverSpec.get(key));
                }
                serverSpec = existingSpec;
            }

            // Update or add the server
            mcpServers.add(serverId, serverSpec);

            // Update the disabledMcpServers list
            if (!mcpConfig.has("disabledMcpServers") || !mcpConfig.get("disabledMcpServers").isJsonArray()) {
                mcpConfig.add("disabledMcpServers", new JsonArray());
            }
            JsonArray disabledArray = mcpConfig.getAsJsonArray("disabledMcpServers");

            if (projectPath == null) {
                JsonArray newDisabled = new JsonArray();
                for (JsonElement elem : disabledArray) {
                    if (!elem.getAsString().equals(serverId)) {
                        newDisabled.add(elem);
                    }
                }
                if (!isEnabled) {
                    newDisabled.add(serverId);
                }
                mcpConfig.add("disabledMcpServers", newDisabled);
            } else if (isEnabled) {
                JsonArray newDisabled = new JsonArray();
                for (JsonElement elem : disabledArray) {
                    if (!elem.getAsString().equals(serverId)) {
                        newDisabled.add(elem);
                    }
                }
                mcpConfig.add("disabledMcpServers", newDisabled);
            }

            if (projectPath != null) {
                if (!mcpConfig.has("projects") || !mcpConfig.get("projects").isJsonObject()) {
                    mcpConfig.add("projects", new JsonObject());
                }
                JsonObject projects = mcpConfig.getAsJsonObject("projects");
                if (!projects.has(projectPath) || !projects.get(projectPath).isJsonObject()) {
                    projects.add(projectPath, new JsonObject());
                }
                JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                if (!projectConfig.has("disabledMcpServers") || !projectConfig.get("disabledMcpServers").isJsonArray()) {
                    projectConfig.add("disabledMcpServers", new JsonArray());
                }
                JsonArray projectDisabledArray = projectConfig.getAsJsonArray("disabledMcpServers");

                JsonArray newProjectDisabled = new JsonArray();
                for (JsonElement elem : projectDisabledArray) {
                    if (!elem.getAsString().equals(serverId)) {
                        newProjectDisabled.add(elem);
                    }
                }
                if (!isEnabled) {
                    newProjectDisabled.add(serverId);
                }
                projectConfig.add("disabledMcpServers", newProjectDisabled);
            }

            writeCodeaideMcpConfig(mcpConfig);

            LOG.info("[McpServerManager] Upserted MCP server in ~/.codeaide/mcp.json: " + serverId
                             + " (enabled: " + isEnabled + ", projectPath: " + (projectPath != null ? projectPath : "(global)") + ")");
            return;
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Error updating ~/.codeaide/mcp.json: " + e.getMessage());
        }

        // 2. Fall back to ~/.codeaide/config.json
        JsonObject config = configReader.apply(null);
        JsonArray servers;

        if (config.has("mcpServers")) {
            servers = config.getAsJsonArray("mcpServers");
        } else {
            servers = new JsonArray();
            config.add("mcpServers", servers);
        }

        boolean found = false;

        // Find and update
        for (int i = 0; i < servers.size(); i++) {
            JsonObject s = servers.get(i).getAsJsonObject();
            if (s.has("id") && s.get("id").getAsString().equals(serverId)) {
                servers.set(i, server); // Replace
                found = true;
                break;
            }
        }

        if (!found) {
            servers.add(server);
        }

        configWriter.accept(config);
        LOG.info("[McpServerManager] Upserted MCP server in ~/.codeaide/config.json: " + serverId);
    }

    /**
     * Delete an MCP server.
     * Deletes from the plugin-owned ~/.codeaide/mcp.json (seeding it from the
     * effective config on first write), falling back to ~/.codeaide/config.json.
     */
    public boolean deleteMcpServer(String serverId) throws IOException {
        boolean removed = false;

        try {
            JsonObject mcpConfig = loadEffectiveMcpConfig();
            if (mcpConfig != null && mcpConfig.has("mcpServers") && mcpConfig.get("mcpServers").isJsonObject()) {
                JsonObject mcpServers = mcpConfig.getAsJsonObject("mcpServers");

                if (mcpServers.has(serverId)) {
                    // Delete the server
                    mcpServers.remove(serverId);

                    // Also remove from disabledMcpServers (if present)
                    if (mcpConfig.has("disabledMcpServers") && mcpConfig.get("disabledMcpServers").isJsonArray()) {
                        JsonArray disabledServers = mcpConfig.getAsJsonArray("disabledMcpServers");
                        JsonArray newDisabled = new JsonArray();
                        for (JsonElement elem : disabledServers) {
                            if (!elem.getAsString().equals(serverId)) {
                                newDisabled.add(elem);
                            }
                        }
                        mcpConfig.add("disabledMcpServers", newDisabled);
                    }

                    writeCodeaideMcpConfig(mcpConfig);

                    LOG.info("[McpServerManager] Deleted MCP server from ~/.codeaide/mcp.json: " + serverId);
                    return true;
                }
            }
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Error deleting from ~/.codeaide/mcp.json: " + e.getMessage());
        }

        // 2. Fall back to ~/.codeaide/config.json
        JsonObject config = configReader.apply(null);
        if (config.has("mcpServers")) {
            JsonArray servers = config.getAsJsonArray("mcpServers");
            JsonArray newServers = new JsonArray();

            for (JsonElement elem : servers) {
                JsonObject s = elem.getAsJsonObject();
                if (s.has("id") && s.get("id").getAsString().equals(serverId)) {
                    removed = true;
                } else {
                    newServers.add(s);
                }
            }

            if (removed) {
                config.add("mcpServers", newServers);
                configWriter.accept(config);
                LOG.info("[McpServerManager] Deleted MCP server from ~/.codeaide/config.json: " + serverId);
            }
        }

        return removed;
    }

    /**
     * Validate MCP server configuration.
     */
    public Map<String, Object> validateMcpServer(JsonObject server) {
        List<String> errors = new ArrayList<>();

        if (!server.has("name") || server.get("name").getAsString().isEmpty()) {
            errors.add("Server name must not be empty");
        }

        if (server.has("server")) {
            JsonObject serverSpec = server.getAsJsonObject("server");
            String type = serverSpec.has("type") ? serverSpec.get("type").getAsString() : "stdio";

            if ("stdio".equals(type)) {
                if (!serverSpec.has("command") || serverSpec.get("command").getAsString().isEmpty()) {
                    errors.add("Command must not be empty");
                }
            } else if ("http".equals(type) || "sse".equals(type)) {
                if (!serverSpec.has("url") || serverSpec.get("url").getAsString().isEmpty()) {
                    errors.add("URL must not be empty");
                } else {
                    String url = serverSpec.get("url").getAsString();
                    try {
                        new java.net.URI(url).toURL();
                    } catch (Exception e) {
                        errors.add("Invalid URL format");
                    }
                }
            } else {
                errors.add("Unsupported connection type: " + type);
            }
        } else {
            errors.add("Missing server configuration details");
        }

        Map<String, Object> result = new HashMap<>();
        result.put("valid", errors.isEmpty());
        result.put("errors", errors);
        return result;
    }
}
