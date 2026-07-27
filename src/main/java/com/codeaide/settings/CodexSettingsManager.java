package com.codeaide.settings;

import com.codeaide.bridge.NodeDetector;
import com.codeaide.provider.codex.CodexConfigTomlRewriter;
import com.codeaide.provider.codex.ResponsesProxyService;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Codex Settings Manager
 * Manages config.toml and auth.json files for the Codex runtime.
 *
 * Directory routing (Phase 5c): managed providers use the plugin-owned isolated
 * CODEX_HOME at ~/.codeaide/codex-home/ so the plugin never writes the official
 * ~/.codex files. The __codex_cli_login__ mode is the exception: it keeps using
 * the real ~/.codex directory (read-only usage of the user's CLI login state).
 */
public class CodexSettingsManager {
    private static final Logger LOG = Logger.getInstance(CodexSettingsManager.class);

    // Pattern to validate TOML bare keys (letters, digits, hyphens, underscores)
    private static final Pattern TOML_KEY_PATTERN = Pattern.compile("^[a-zA-Z0-9_-]+$");

    private final Gson gson;
    private final Path codexDir;
    private final Path isolatedCodexDir;
    private final Path codeaideConfigPath;

    public CodexSettingsManager(Gson gson) {
        this.gson = gson;
        String userHome = NodeDetector.resolveHomeForFileOps();
        this.codexDir = Paths.get(userHome, ".codex");
        this.isolatedCodexDir = Paths.get(userHome, ".codeaide", "codex-home");
        this.codeaideConfigPath = Paths.get(userHome, ".codeaide", "config.json");
    }

    /**
     * Resolve the directory that config.toml/auth.json operations target for the
     * current mode: the real ~/.codex for Codex CLI login mode, the plugin-owned
     * isolated CODEX_HOME (~/.codeaide/codex-home) otherwise.
     */
    public Path resolveEffectiveCodexDir() {
        return isCodexCliLoginMode() ? codexDir : isolatedCodexDir;
    }

    /**
     * Whether Codex CLI login mode is active, decided solely by the plugin-owned
     * ~/.codeaide/config.json (codex.current === "__codex_cli_login__" with
     * localConfigAuthorized). Best-effort: unreadable config means "not CLI login",
     * which routes writes to the isolated directory (never touches ~/.codex).
     */
    private boolean isCodexCliLoginMode() {
        try {
            if (!Files.exists(codeaideConfigPath)) {
                return false;
            }
            String content = Files.readString(codeaideConfigPath, StandardCharsets.UTF_8);
            JsonObject config = JsonParser.parseString(content).getAsJsonObject();
            if (!config.has("codex") || !config.get("codex").isJsonObject()) {
                return false;
            }
            JsonObject codex = config.getAsJsonObject("codex");
            String currentId = codex.has("current") && !codex.get("current").isJsonNull()
                    ? codex.get("current").getAsString().trim()
                    : "";
            boolean authorized = codex.has("localConfigAuthorized")
                    && !codex.get("localConfigAuthorized").isJsonNull()
                    && codex.get("localConfigAuthorized").getAsBoolean();
            return authorized && CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID.equals(currentId);
        } catch (Exception e) {
            LOG.debug("[CodexSettingsManager] Failed to resolve Codex mode, using isolated dir: " + e.getMessage());
            return false;
        }
    }

    /**
     * Ensure the effective Codex directory exists
     */
    public void ensureCodexDirectory() throws IOException {
        Path dir = resolveEffectiveCodexDir();
        if (!Files.exists(dir)) {
            Files.createDirectories(dir);
            LOG.info("[CodexSettingsManager] Created Codex directory: " + dir);
        }
    }

    /**
     * Ensure the plugin-owned isolated CODEX_HOME (~/.codeaide/codex-home) exists and,
     * when possible, link its sessions/ directory to the official ~/.codex/sessions
     * so session history stays in the official location (shared with the Codex CLI)
     * even though config/auth are isolated. Best-effort: logs and continues on
     * filesystems where links cannot be created.
     *
     * <p>When the user opted into full session isolation ({@code codex.isolateSessions}
     * in ~/.codeaide/config.json, see CodeaideSettingsService#isCodexSessionsIsolationEnabled),
     * no link is created and sessions stay inside the isolated CODEX_HOME. This is
     * strictly non-destructive: an already existing link or directory is never
     * removed or overwritten.
     */
    public static void ensureIsolatedCodexHome() {
        try {
            String userHome = NodeDetector.resolveHomeForFileOps();
            Path isolatedDir = Paths.get(userHome, ".codeaide", "codex-home");
            Path codeaideConfigPath = Paths.get(userHome, ".codeaide", "config.json");
            Path realSessionsDir = Paths.get(userHome, ".codex", "sessions");
            Path linkedSessionsDir = isolatedDir.resolve("sessions");

            Files.createDirectories(isolatedDir);

            if (isSessionsIsolationEnabled(codeaideConfigPath)) {
                // Full isolation: sessions stay inside the isolated CODEX_HOME and
                // the official ~/.codex is left completely untouched. If a
                // previously created shared-sessions link still exists it keeps
                // redirecting — warn (never delete user data or links) so the user
                // can remove it manually to complete the isolation.
                if (Files.isSymbolicLink(linkedSessionsDir)) {
                    LOG.warn("[CodexSettingsManager] codex.isolateSessions is enabled but the existing "
                            + "shared sessions link " + linkedSessionsDir + " was preserved "
                            + "(links are never deleted). Delete that link manually to fully "
                            + "isolate session history from ~/.codex.");
                }
                return;
            }

            if (Files.exists(linkedSessionsDir)) {
                // Already a link or a real directory with sessions; never overwrite user data.
                return;
            }

            Files.createDirectories(realSessionsDir);
            try {
                Files.createSymbolicLink(linkedSessionsDir, realSessionsDir);
                LOG.info("[CodexSettingsManager] Linked isolated Codex sessions to " + realSessionsDir);
            } catch (Exception linkFailure) {
                // Windows without symlink privilege: try a directory junction (no admin needed).
                if (!tryCreateWindowsJunction(linkedSessionsDir, realSessionsDir)) {
                    LOG.warn("[CodexSettingsManager] Could not link isolated Codex sessions dir to "
                            + realSessionsDir + ": " + linkFailure.getMessage()
                            + " (sessions will be stored under the isolated CODEX_HOME)");
                }
            }
        } catch (Exception e) {
            LOG.warn("[CodexSettingsManager] Failed to prepare isolated CODEX_HOME: " + e.getMessage());
        }
    }

    /**
     * Read the {@code codex.isolateSessions} flag from ~/.codeaide/config.json.
     * Best-effort: an unreadable or missing config means false (the default
     * shared-history behavior), mirroring {@link #isCodexCliLoginMode()}.
     */
    static boolean isSessionsIsolationEnabled(Path codeaideConfigPath) {
        try {
            if (!Files.exists(codeaideConfigPath)) {
                return false;
            }
            String content = Files.readString(codeaideConfigPath, StandardCharsets.UTF_8);
            JsonObject config = JsonParser.parseString(content).getAsJsonObject();
            if (!config.has("codex") || !config.get("codex").isJsonObject()) {
                return false;
            }
            JsonObject codex = config.getAsJsonObject("codex");
            return codex.has("isolateSessions")
                    && !codex.get("isolateSessions").isJsonNull()
                    && codex.get("isolateSessions").getAsBoolean();
        } catch (Exception e) {
            LOG.debug("[CodexSettingsManager] Failed to read codex.isolateSessions, defaulting to shared sessions: "
                    + e.getMessage());
            return false;
        }
    }

    /**
     * Create a Windows directory junction via mklink /J (works without admin rights,
     * unlike symlinks). No-op on non-Windows platforms.
     */
    private static boolean tryCreateWindowsJunction(Path link, Path target) {
        if (!com.codeaide.util.PlatformUtils.isWindows()) {
            return false;
        }
        try {
            Process process = new ProcessBuilder(
                    "cmd", "/c", "mklink", "/J", link.toString(), target.toString())
                    .redirectErrorStream(true)
                    .start();
            int exitCode = process.waitFor();
            if (exitCode == 0) {
                LOG.info("[CodexSettingsManager] Created junction " + link + " -> " + target);
                return true;
            }
            LOG.debug("[CodexSettingsManager] mklink /J failed with exit code " + exitCode);
        } catch (Exception e) {
            LOG.debug("[CodexSettingsManager] mklink /J failed: " + e.getMessage());
        }
        return false;
    }

    /**
     * Get path to config.toml (effective directory for the current mode)
     */
    public Path getConfigTomlPath() {
        return resolveEffectiveCodexDir().resolve("config.toml");
    }

    /**
     * Get path to auth.json (effective directory for the current mode)
     */
    public Path getAuthJsonPath() {
        return resolveEffectiveCodexDir().resolve("auth.json");
    }

    /**
     * Read config.toml as a map structure (effective directory for the current mode).
     * Returns null if file doesn't exist
     */
    public Map<String, Object> readConfigToml() throws IOException {
        return readConfigTomlFrom(getConfigTomlPath());
    }

    private Map<String, Object> readConfigTomlFrom(Path configPath) throws IOException {
        if (!Files.exists(configPath)) {
            LOG.info("[CodexSettingsManager] config.toml not found at: " + configPath);
            return null;
        }

        try {
            String content = Files.readString(configPath, StandardCharsets.UTF_8);
            return parseToml(content);
        } catch (Exception e) {
            LOG.warn("[CodexSettingsManager] Failed to read config.toml: " + e.getMessage());
            throw new IOException("Failed to read config.toml: " + e.getMessage(), e);
        }
    }

    /**
     * Write config.toml from a map structure
     */
    public void writeConfigToml(Map<String, Object> config) throws IOException {
        Path configPath = getConfigTomlPath();

        String tomlContent = generateToml(config);
        writeStringAtomically(configPath, tomlContent);
        LOG.info("[CodexSettingsManager] Wrote config.toml to: " + configPath);
    }

    /**
     * Write config.toml from raw string content
     */
    public void writeConfigTomlRaw(String content) throws IOException {
        writeConfigTomlRawTo(getConfigTomlPath(), content);
    }

    private void writeConfigTomlRawTo(Path configPath, String content) throws IOException {
        writeStringAtomically(configPath, content);
        LOG.info("[CodexSettingsManager] Wrote raw config.toml to: " + configPath);
    }

    /**
     * Read auth.json (effective directory for the current mode)
     */
    public JsonObject readAuthJson() throws IOException {
        return readAuthJsonFrom(getAuthJsonPath());
    }

    private JsonObject readAuthJsonFrom(Path authPath) throws IOException {
        if (!Files.exists(authPath)) {
            LOG.info("[CodexSettingsManager] auth.json not found at: " + authPath);
            return null;
        }

        try (Reader reader = Files.newBufferedReader(authPath, StandardCharsets.UTF_8)) {
            return JsonParser.parseReader(reader).getAsJsonObject();
        } catch (Exception e) {
            LOG.warn("[CodexSettingsManager] Failed to read auth.json: " + e.getMessage());
            throw new IOException("Failed to read auth.json: " + e.getMessage(), e);
        }
    }

    /**
     * Write auth.json
     */
    public void writeAuthJson(JsonObject auth) throws IOException {
        Path authPath = getAuthJsonPath();

        writeStringAtomically(authPath, gson.toJson(auth));
        LOG.info("[CodexSettingsManager] Wrote auth.json to: " + authPath);
    }

    /**
     * Apply provider configuration to the effective Codex settings files.
     * Managed providers land in the isolated CODEX_HOME (~/.codeaide/codex-home);
     * the official ~/.codex files are only touched in CLI login mode.
     *
     * @param provider The provider configuration containing config and auth data
     */
    public void applyProviderToCodexSettings(JsonObject provider) throws IOException {
        if (provider == null) {
            LOG.warn("[CodexSettingsManager] Cannot apply null provider");
            return;
        }

        // Check if provider has configToml (raw string format)
        if (provider.has("configToml") && provider.get("configToml").isJsonPrimitive()) {
            String configTomlContent = provider.get("configToml").getAsString();
            configTomlContent = routeChatWireApiThroughResponsesProxy(configTomlContent);
            writeConfigTomlRaw(configTomlContent);
        }

        // Check if provider has authJson (raw string format)
        if (provider.has("authJson") && provider.get("authJson").isJsonPrimitive()) {
            String authJsonContent = provider.get("authJson").getAsString();
            if (authJsonContent != null && !authJsonContent.trim().isEmpty()) {
                try {
                    JsonObject authObj = JsonParser.parseString(authJsonContent).getAsJsonObject();
                    writeAuthJson(authObj);
                } catch (Exception e) {
                    LOG.warn("[CodexSettingsManager] Failed to parse authJson: " + e.getMessage());
                }
            }
        }

        String providerId = provider.has("id") ? provider.get("id").getAsString() : "unknown";
        LOG.info("[CodexSettingsManager] Applied provider to " + resolveEffectiveCodexDir() + ": " + providerId);
    }

    /**
     * Routes providers whose upstream only speaks Chat Completions
     * ({@code wire_api = "chat"}) through the built-in local Responses API proxy.
     * New Codex versions removed the chat wire API, so the effective config.toml
     * must use {@code wire_api = "responses"} pointing at the localhost proxy;
     * the proxy converts protocols against the real upstream. On any failure the
     * original content is returned unchanged (the user can still run an external
     * router such as cc-switch).
     */
    private String routeChatWireApiThroughResponsesProxy(String configTomlContent) {
        try {
            if (!CodexConfigTomlRewriter.needsConversion(configTomlContent)) {
                return configTomlContent;
            }
            String upstream = CodexConfigTomlRewriter.extractBaseUrl(configTomlContent);
            if (upstream == null || upstream.isEmpty()) {
                LOG.warn("[CodexSettingsManager] wire_api=chat but no base_url found; writing config as-is");
                return configTomlContent;
            }
            String proxyBaseUrl = ResponsesProxyService.getInstance().ensureRunningAndConfigure(upstream);
            if (proxyBaseUrl == null) {
                LOG.warn("[CodexSettingsManager] Responses proxy unavailable; writing wire_api=chat "
                        + "config as-is (new Codex versions may reject it)");
                return configTomlContent;
            }
            LOG.info("[CodexSettingsManager] Routing chat-completions upstream " + upstream
                    + " through local responses proxy at " + proxyBaseUrl);
            return CodexConfigTomlRewriter.rewriteForProxy(configTomlContent, proxyBaseUrl);
        } catch (Exception e) {
            LOG.warn("[CodexSettingsManager] Failed to route config through responses proxy: "
                    + e.getMessage());
            return configTomlContent;
        }
    }

    /**
     * Atomic write helper: write to a temp file in the same directory, then replace the target.
     * Prevents consumers (e.g., Codex SDK/CLI) from observing a partially written file.
     */
    private void writeStringAtomically(Path target, String content) throws IOException {
        Path parent = target.getParent();
        if (parent == null) {
            // Should never happen for {config.toml,auth.json} under a Codex home
            Files.writeString(target, content, StandardCharsets.UTF_8);
            return;
        }
        Files.createDirectories(parent);

        String prefix = target.getFileName() != null ? target.getFileName() + "-" : "codex-";
        Path tmp = Files.createTempFile(parent, prefix, ".tmp");
        try {
            // Security (J): restrict to owner read/write (0600) before writing secrets
            // (auth.json holds OAuth tokens; config.toml may hold API keys). The atomic
            // move below preserves these permissions on the target file.
            hardenFilePermissions(tmp);
            Files.writeString(tmp, content, StandardCharsets.UTF_8);
            try {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            try {
                Files.deleteIfExists(tmp);
            } catch (Exception e) {
                LOG.debug("[CodexSettingsManager] Failed to cleanup temp file: " + tmp + " (" + e.getMessage() + ")");
            }
        }
    }

    /**
     * Best-effort restrict a file to owner read/write (0600). No-op on non-POSIX
     * filesystems (e.g. Windows), where the per-user home directory ACL applies. (Security J)
     */
    private static void hardenFilePermissions(Path path) {
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException e) {
            LOG.debug("[CodexSettingsManager] Could not set 0600 on " + path + ": " + e.getMessage());
        }
    }

    /**
     * Check if Codex CLI login credentials are available in the real ~/.codex/auth.json.
     * Always targets the official directory (CLI login state lives there, never in the
     * isolated CODEX_HOME). Looks for "auth_mode": "chatgpt" and valid tokens.
     */
    public boolean isCodexCliLoginAvailable() {
        try {
            JsonObject auth = readAuthJsonFrom(codexDir.resolve("auth.json"));
            if (auth == null) {
                return false;
            }
            // Check for chatgpt auth mode with tokens
            if (auth.has("auth_mode") && "chatgpt".equals(auth.get("auth_mode").getAsString())) {
                if (auth.has("tokens") && auth.get("tokens").isJsonObject()) {
                    JsonObject tokens = auth.getAsJsonObject("tokens");
                    return tokens.has("access_token") && !tokens.get("access_token").isJsonNull();
                }
            }
            return false;
        } catch (Exception e) {
            LOG.debug("[CodexSettingsManager] Failed to check CLI login availability: " + e.getMessage());
            return false;
        }
    }

    /**
     * Read Codex CLI login account info (email, name) from the JWT id_token in auth.json.
     * Only extracts safe display fields, never credentials or tokens.
     *
     * <p><b>Security note:</b> The JWT payload is decoded without signature verification.
     * The returned data is intended <b>only for UI display</b> (email, name, plan type)
     * and MUST NOT be used for authorization or access-control decisions.</p>
     *
     * @return JsonObject with email/name, or null if not available
     */
    public JsonObject readCodexCliLoginAccountInfo() {
        try {
            JsonObject auth = readAuthJsonFrom(codexDir.resolve("auth.json"));
            if (auth == null || !auth.has("tokens") || !auth.get("tokens").isJsonObject()) {
                return null;
            }

            JsonObject tokens = auth.getAsJsonObject("tokens");
            if (!tokens.has("id_token") || tokens.get("id_token").isJsonNull()) {
                return null;
            }

            String idToken = tokens.get("id_token").getAsString();
            // JWT format: header.payload.signature — decode the payload section
            String[] parts = idToken.split("\\.");
            if (parts.length < 2) {
                return null;
            }

            // Base64url decode the payload
            String payload = parts[1];
            // Pad to multiple of 4
            while (payload.length() % 4 != 0) {
                payload += "=";
            }
            byte[] decoded = java.util.Base64.getUrlDecoder().decode(payload);
            String jsonStr = new String(decoded, StandardCharsets.UTF_8);

            JsonObject claims = JsonParser.parseString(jsonStr).getAsJsonObject();
            JsonObject safeInfo = new JsonObject();

            if (claims.has("email")) {
                safeInfo.addProperty("emailAddress", claims.get("email").getAsString());
            }
            if (claims.has("name")) {
                safeInfo.addProperty("name", claims.get("name").getAsString());
            }

            // Also extract plan info if available (from https://api.openai.com/auth claim)
            if (claims.has("https://api.openai.com/auth") && claims.get("https://api.openai.com/auth").isJsonObject()) {
                JsonObject authClaim = claims.getAsJsonObject("https://api.openai.com/auth");
                if (authClaim.has("chatgpt_plan_type")) {
                    safeInfo.addProperty("planType", authClaim.get("chatgpt_plan_type").getAsString());
                }
            }

            return safeInfo;
        } catch (Exception e) {
            LOG.debug("[CodexSettingsManager] Failed to read CLI login account info: " + e.getMessage());
            return null;
        }
    }

    /**
     * Apply Codex CLI login mode to the real ~/.codex/ settings.
     * Clears config.toml (to use official defaults) while preserving auth.json (OAuth tokens).
     * Backs up existing config.toml before clearing.
     * Always targets the official ~/.codex directory (CLI login state lives there).
     *
     * @throws IOException if backup or write fails
     */
    public void applyCodexCliLoginToSettings() throws IOException {
        Path configTomlPath = codexDir.resolve("config.toml");
        Path backupPath = codexDir.resolve("config.toml.cli_backup");

        // Backup existing config.toml if it exists and has content
        if (Files.exists(configTomlPath)) {
            String content = Files.readString(configTomlPath, StandardCharsets.UTF_8);
            if (content != null && !content.trim().isEmpty()) {
                Files.copy(configTomlPath, backupPath, StandardCopyOption.REPLACE_EXISTING);
                LOG.info("[CodexSettingsManager] Backed up config.toml to: " + backupPath);
            }
        }

        // Clear config.toml — empty file means Codex SDK uses official defaults
        writeConfigTomlRawTo(configTomlPath, "");

        // auth.json is left untouched — it already contains the OAuth tokens from 'codex login'
        LOG.info("[CodexSettingsManager] Applied Codex CLI login mode (config.toml cleared, auth.json preserved)");
    }

    /**
     * Remove Codex CLI login mode by restoring the backed-up config.toml.
     * Called when switching away from CLI login mode.
     *
     * @throws IOException if restore fails
     */
    public void removeCodexCliLoginFromSettings() throws IOException {
        Path backupPath = codexDir.resolve("config.toml.cli_backup");

        if (Files.exists(backupPath)) {
            Path configTomlPath = codexDir.resolve("config.toml");
            Files.copy(backupPath, configTomlPath, StandardCopyOption.REPLACE_EXISTING);
            Files.deleteIfExists(backupPath);
            LOG.info("[CodexSettingsManager] Restored config.toml from CLI login backup");
        } else {
            LOG.info("[CodexSettingsManager] No CLI login backup found, nothing to restore");
        }
    }

    /**
     * Get current Codex configuration (combined from config.toml and auth.json)
     * from the effective directory for the current mode.
     */
    public JsonObject getCurrentCodexConfig() throws IOException {
        return getCurrentCodexConfigFrom(getConfigTomlPath(), getAuthJsonPath());
    }

    /**
     * Get the current Codex configuration from the real ~/.codex directory,
     * regardless of mode. Used by the "local config" display which the user
     * explicitly authorized (localConfigAuthorized).
     */
    public JsonObject getCurrentCodexConfigFromRealDir() throws IOException {
        return getCurrentCodexConfigFrom(
                codexDir.resolve("config.toml"), codexDir.resolve("auth.json"));
    }

    private JsonObject getCurrentCodexConfigFrom(Path configTomlPath, Path authJsonPath) throws IOException {
        JsonObject result = new JsonObject();

        // Read config.toml
        Map<String, Object> configToml = readConfigTomlFrom(configTomlPath);
        if (configToml != null) {
            result.add("config", mapToJsonObject(configToml));
        }

        // Read auth.json
        JsonObject authJson = readAuthJsonFrom(authJsonPath);
        if (authJson != null) {
            result.add("auth", authJson);
        }

        return result;
    }

    // ==================== TOML Parsing Utilities ====================

    /**
     * Simple TOML parser (handles basic key=value and [section] syntax)
     */
    private Map<String, Object> parseToml(String content) {
        Map<String, Object> result = new LinkedHashMap<>();
        Map<String, Object> currentSection = result;

        String[] lines = content.split("\n");
        for (String line : lines) {
            line = line.trim();

            // Skip empty lines and comments
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }

            // Array of tables header [[section.subsection]]
            if (line.startsWith("[[") && line.endsWith("]]")) {
                String sectionName = line.substring(2, line.length() - 2).trim();

                // Navigate to parent, then append a new map to the List at the leaf key
                String[] parts = sectionName.split("\\.");
                Map<String, Object> nav = result;
                boolean navFailed = false;
                for (int i = 0; i < parts.length - 1; i++) {
                    if (!nav.containsKey(parts[i])) {
                        nav.put(parts[i], new LinkedHashMap<String, Object>());
                    }
                    Object next = nav.get(parts[i]);
                    if (next instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> nextMap = (Map<String, Object>) next;
                        nav = nextMap;
                    } else {
                        // Type conflict: intermediate node is not a Map
                        LOG.warn("[CodexSettingsManager] Type conflict at key '" + parts[i] + "' in [[" + sectionName + "]], skipping");
                        navFailed = true;
                        break;
                    }
                }

                if (navFailed) {
                    // Use a throwaway map so subsequent key=value lines don't corrupt other sections
                    currentSection = new LinkedHashMap<>();
                    continue;
                }
                currentSection = nav;

                // At the leaf key, create or get a List<Map> and append a new entry
                String leafKey = parts[parts.length - 1];
                if (!nav.containsKey(leafKey)) {
                    nav.put(leafKey, new ArrayList<Map<String, Object>>());
                }
                Object leafVal = nav.get(leafKey);
                if (leafVal instanceof List) {
                    @SuppressWarnings("unchecked")
                    List<Map<String, Object>> tableList = (List<Map<String, Object>>) leafVal;
                    Map<String, Object> newEntry = new LinkedHashMap<>();
                    tableList.add(newEntry);
                    currentSection = newEntry;
                } else {
                    LOG.warn("[CodexSettingsManager] Type conflict at leaf key '" + leafKey + "' in [[" + sectionName + "]], expected List");
                    currentSection = new LinkedHashMap<>();
                }
                continue;
            }

            // Section header [section] or [section.subsection]
            if (line.startsWith("[") && line.endsWith("]")) {
                String sectionName = line.substring(1, line.length() - 1).trim();

                // Navigate/create nested sections
                String[] parts = sectionName.split("\\.");
                Map<String, Object> nav = result;
                boolean navFailed = false;
                for (String part : parts) {
                    if (!nav.containsKey(part)) {
                        nav.put(part, new LinkedHashMap<String, Object>());
                    }
                    Object next = nav.get(part);
                    if (next instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> nextMap = (Map<String, Object>) next;
                        nav = nextMap;
                    } else {
                        // Type conflict: node is not a Map (could be a List or simple value)
                        LOG.warn("[CodexSettingsManager] Type conflict at key '" + part + "' in [" + sectionName + "], skipping");
                        navFailed = true;
                        break;
                    }
                }

                currentSection = navFailed ? new LinkedHashMap<>() : nav;
                continue;
            }

            // Key = value
            int eqIndex = line.indexOf('=');
            if (eqIndex > 0) {
                String key = line.substring(0, eqIndex).trim();
                String valueStr = line.substring(eqIndex + 1).trim();
                Object value = parseTomlValue(valueStr);
                currentSection.put(key, value);
            }
        }

        return result;
    }

    /**
     * Parse a TOML value string
     */
    private Object parseTomlValue(String valueStr) {
        if (valueStr.isEmpty()) {
            return "";
        }

        // Boolean
        if (valueStr.equals("true")) {
            return true;
        }
        if (valueStr.equals("false")) {
            return false;
        }

        // Array: [value1, value2, ...]
        if (valueStr.startsWith("[") && valueStr.endsWith("]")) {
            return parseTomlArray(valueStr);
        }

        // Inline table: { key = "value", ... }
        if (valueStr.startsWith("{") && valueStr.endsWith("}")) {
            return parseTomlInlineTable(valueStr);
        }

        // String (quoted)
        if ((valueStr.startsWith("\"") && valueStr.endsWith("\"")) ||
                    (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
            return unescapeTomlString(valueStr.substring(1, valueStr.length() - 1));
        }

        // Number
        try {
            if (valueStr.contains(".")) {
                return Double.parseDouble(valueStr);
            } else {
                return Long.parseLong(valueStr);
            }
        } catch (NumberFormatException ignored) {
        }

        // Default: treat as unquoted string
        return valueStr;
    }

    /**
     * Parse a TOML array: [value1, value2, ...]
     */
    private List<Object> parseTomlArray(String arrayStr) {
        List<Object> result = new ArrayList<>();
        String content = arrayStr.substring(1, arrayStr.length() - 1).trim();

        if (content.isEmpty()) {
            return result;
        }

        // Split by comma, respecting quotes and nested structures
        List<String> elements = splitTomlElements(content, ',');
        for (String element : elements) {
            element = element.trim();
            if (!element.isEmpty()) {
                result.add(parseTomlValue(element));
            }
        }
        return result;
    }

    /**
     * Parse a TOML inline table: { key = "value", ... }
     */
    private Map<String, Object> parseTomlInlineTable(String tableStr) {
        Map<String, Object> result = new LinkedHashMap<>();
        String content = tableStr.substring(1, tableStr.length() - 1).trim();

        if (content.isEmpty()) {
            return result;
        }

        // Split by comma, respecting quotes and nested structures
        List<String> pairs = splitTomlElements(content, ',');
        for (String pair : pairs) {
            pair = pair.trim();
            int eqIndex = pair.indexOf('=');
            if (eqIndex > 0) {
                String key = pair.substring(0, eqIndex).trim();
                String valueStr = pair.substring(eqIndex + 1).trim();
                // Remove quotes from key if present
                if ((key.startsWith("\"") && key.endsWith("\"")) ||
                            (key.startsWith("'") && key.endsWith("'"))) {
                    key = key.substring(1, key.length() - 1);
                }
                result.put(key, parseTomlValue(valueStr));
            }
        }
        return result;
    }

    /**
     * Split TOML elements by delimiter, respecting quotes and nested structures
     */
    private List<String> splitTomlElements(String content, char delimiter) {
        List<String> result = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        int depth = 0;
        boolean inDoubleQuote = false;
        boolean inSingleQuote = false;
        boolean escaped = false;

        for (int i = 0; i < content.length(); i++) {
            char c = content.charAt(i);

            if (escaped) {
                current.append(c);
                escaped = false;
                continue;
            }

            if (c == '\\') {
                current.append(c);
                escaped = true;
                continue;
            }

            if (c == '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
                current.append(c);
                continue;
            }

            if (c == '\'' && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
                current.append(c);
                continue;
            }

            if (!inDoubleQuote && !inSingleQuote) {
                if (c == '[' || c == '{') {
                    depth++;
                } else if (c == ']' || c == '}') {
                    depth--;
                } else if (c == delimiter && depth == 0) {
                    result.add(current.toString());
                    current = new StringBuilder();
                    continue;
                }
            }

            current.append(c);
        }

        if (current.length() > 0) {
            result.add(current.toString());
        }

        return result;
    }

    /**
     * Unescape TOML string (handle \n, \t, \\, \", etc.)
     */
    private String unescapeTomlString(String str) {
        StringBuilder result = new StringBuilder();
        boolean escaped = false;

        for (int i = 0; i < str.length(); i++) {
            char c = str.charAt(i);
            if (escaped) {
                switch (c) {
                    case 'n':
                        result.append('\n');
                        break;
                    case 't':
                        result.append('\t');
                        break;
                    case 'r':
                        result.append('\r');
                        break;
                    case '\\':
                        result.append('\\');
                        break;
                    case '"':
                        result.append('"');
                        break;
                    case '\'':
                        result.append('\'');
                        break;
                    default:
                        result.append('\\').append(c);
                        break;
                }
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else {
                result.append(c);
            }
        }

        if (escaped) {
            result.append('\\');
        }

        return result.toString();
    }

    /**
     * Generate TOML string from map
     */
    private String generateToml(Map<String, Object> config) {
        StringBuilder sb = new StringBuilder();

        // First, write top-level key=value pairs (exclude Map sections and array of tables)
        for (Map.Entry<String, Object> entry : config.entrySet()) {
            Object val = entry.getValue();
            if (!(val instanceof Map) && !isArrayOfTables(val)) {
                if (!isValidTomlKey(entry.getKey())) {
                    LOG.warn("[CodexSettingsManager] Skipping invalid TOML key: " + entry.getKey());
                    continue;
                }
                sb.append(entry.getKey()).append(" = ").append(toTomlValue(val)).append("\n");
            }
        }

        // Then write Map sections
        for (Map.Entry<String, Object> entry : config.entrySet()) {
            if (entry.getValue() instanceof Map) {
                if (!isValidTomlKey(entry.getKey())) {
                    LOG.warn("[CodexSettingsManager] Skipping invalid TOML section key: " + entry.getKey());
                    continue;
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> section = (Map<String, Object>) entry.getValue();
                writeTomlSection(sb, entry.getKey(), section);
            }
        }

        // Finally, write top-level array of tables ([[key]])
        for (Map.Entry<String, Object> entry : config.entrySet()) {
            if (isArrayOfTables(entry.getValue())) {
                if (!isValidTomlKey(entry.getKey())) {
                    LOG.warn("[CodexSettingsManager] Skipping invalid TOML array key: " + entry.getKey());
                    continue;
                }
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> tableList = (List<Map<String, Object>>) entry.getValue();
                for (Map<String, Object> tableEntry : tableList) {
                    sb.append("\n[[").append(entry.getKey()).append("]]\n");
                    for (Map.Entry<String, Object> kv : tableEntry.entrySet()) {
                        if (!isValidTomlKey(kv.getKey())) {
                            LOG.warn("[CodexSettingsManager] Skipping invalid TOML key in array entry: " + kv.getKey());
                            continue;
                        }
                        sb.append(kv.getKey()).append(" = ").append(toTomlValue(kv.getValue())).append("\n");
                    }
                }
            }
        }

        return sb.toString();
    }

    /**
     * Write a TOML section recursively.
     * Handles nested Map sections and List&lt;Map&gt; array of tables.
     */
    private void writeTomlSection(StringBuilder sb, String sectionPath, Map<String, Object> section) {
        // A "simple value" is anything that is NOT a nested Map, NOT an array of tables (List<Map>),
        // and NOT an empty list (which would be an empty array of tables with no TOML representation).
        boolean hasSimpleValues = section.values().stream()
                                          .anyMatch(v -> !(v instanceof Map) && !isArrayOfTables(v)
                                                                 && !(v instanceof List && ((List<?>) v).isEmpty()));

        // Write section header and simple values
        if (hasSimpleValues) {
            sb.append("[").append(sectionPath).append("]\n");
            for (Map.Entry<String, Object> entry : section.entrySet()) {
                Object val = entry.getValue();
                // Skip Maps, array of tables, and empty lists
                if (val instanceof Map || isArrayOfTables(val)
                            || (val instanceof List && ((List<?>) val).isEmpty())) {
                    continue;
                }
                if (!isValidTomlKey(entry.getKey())) {
                    LOG.warn("[CodexSettingsManager] Skipping invalid TOML key in section: " + entry.getKey());
                    continue;
                }
                sb.append(entry.getKey()).append(" = ").append(toTomlValue(val)).append("\n");
            }
        }

        // Write nested sections (Map values)
        for (Map.Entry<String, Object> entry : section.entrySet()) {
            if (entry.getValue() instanceof Map) {
                if (!isValidTomlKey(entry.getKey())) {
                    LOG.warn("[CodexSettingsManager] Skipping invalid TOML section key: " + entry.getKey());
                    continue;
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> nestedSection = (Map<String, Object>) entry.getValue();
                writeTomlSection(sb, sectionPath + "." + entry.getKey(), nestedSection);
            }
        }

        // Write array of tables (List<Map> values) as [[section.key]]
        // Note: empty lists (isArrayOfTables returns false) are intentionally skipped
        // because empty array of tables have no valid TOML representation.
        for (Map.Entry<String, Object> entry : section.entrySet()) {
            Object entryVal = entry.getValue();
            // Skip empty lists - they cannot be represented as array of tables in TOML
            if (entryVal instanceof List && ((List<?>) entryVal).isEmpty()) {
                continue;
            }
            if (isArrayOfTables(entryVal)) {
                if (!isValidTomlKey(entry.getKey())) {
                    LOG.warn("[CodexSettingsManager] Skipping invalid TOML array key: " + entry.getKey());
                    continue;
                }
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> tableList = (List<Map<String, Object>>) entry.getValue();
                String arrayPath = sectionPath + "." + entry.getKey();
                for (Map<String, Object> tableEntry : tableList) {
                    sb.append("\n[[").append(arrayPath).append("]]\n");
                    for (Map.Entry<String, Object> kv : tableEntry.entrySet()) {
                        if (!isValidTomlKey(kv.getKey())) {
                            LOG.warn("[CodexSettingsManager] Skipping invalid TOML key in array entry: " + kv.getKey());
                            continue;
                        }
                        sb.append(kv.getKey()).append(" = ").append(toTomlValue(kv.getValue())).append("\n");
                    }
                }
            }
        }
    }

    /**
     * Validates that a key is a valid TOML bare key.
     */
    private boolean isValidTomlKey(String key) {
        return key != null && !key.isEmpty() && TOML_KEY_PATTERN.matcher(key).matches();
    }

    /**
     * Checks if a value is an array of tables (List where elements are Maps).
     */
    private boolean isArrayOfTables(Object value) {
        if (!(value instanceof List<?> list)) {
            return false;
        }
        if (list.isEmpty()) {
            return false;
        }
        for (Object item : list) {
            if (!(item instanceof Map)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Convert Java object to TOML value string
     */
    private String toTomlValue(Object value) {
        if (value == null) {
            return "\"\"";
        }
        if (value instanceof Boolean) {
            return value.toString();
        }
        if (value instanceof Number) {
            return value.toString();
        }
        // List -> TOML array
        if (value instanceof List) {
            @SuppressWarnings("unchecked")
            List<Object> list = (List<Object>) value;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) { sb.append(", "); }
                sb.append(toTomlValue(list.get(i)));
            }
            sb.append("]");
            return sb.toString();
        }
        // Map -> TOML inline table
        if (value instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) value;
            StringBuilder sb = new StringBuilder("{ ");
            boolean first = true;
            for (Map.Entry<String, Object> entry : map.entrySet()) {
                if (!first) { sb.append(", "); }
                first = false;
                sb.append("\"").append(escapeTomlString(entry.getKey())).append("\" = ");
                sb.append(toTomlValue(entry.getValue()));
            }
            sb.append(" }");
            return sb.toString();
        }
        // String: quote it
        String str = value.toString();
        return "\"" + escapeTomlString(str) + "\"";
    }

    /**
     * Escape special characters in TOML string
     */
    private String escapeTomlString(String str) {
        return str.replace("\\", "\\\\")
                       .replace("\"", "\\\"")
                       .replace("\n", "\\n")
                       .replace("\t", "\\t")
                       .replace("\r", "\\r");
    }


    /**
     * Convert Map to JsonObject
     */
    private JsonObject mapToJsonObject(Map<String, Object> map) {
        JsonObject result = new JsonObject();
        for (Map.Entry<String, Object> entry : map.entrySet()) {
            Object value = entry.getValue();
            if (value == null) {
                result.add(entry.getKey(), com.google.gson.JsonNull.INSTANCE);
            } else if (value instanceof Boolean) {
                result.addProperty(entry.getKey(), (Boolean) value);
            } else if (value instanceof Number) {
                result.addProperty(entry.getKey(), (Number) value);
            } else if (value instanceof String) {
                result.addProperty(entry.getKey(), (String) value);
            } else if (value instanceof List) {
                @SuppressWarnings("unchecked")
                List<Object> list = (List<Object>) value;
                result.add(entry.getKey(), listToJsonArray(list));
            } else if (value instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> nestedMap = (Map<String, Object>) value;
                result.add(entry.getKey(), mapToJsonObject(nestedMap));
            } else {
                result.addProperty(entry.getKey(), value.toString());
            }
        }
        return result;
    }

    /**
     * Convert List to JsonArray
     */
    private JsonArray listToJsonArray(List<Object> list) {
        JsonArray result = new JsonArray();
        for (Object item : list) {
            if (item == null) {
                result.add(com.google.gson.JsonNull.INSTANCE);
            } else if (item instanceof Boolean) {
                result.add((Boolean) item);
            } else if (item instanceof Number) {
                result.add((Number) item);
            } else if (item instanceof String) {
                result.add((String) item);
            } else if (item instanceof List) {
                @SuppressWarnings("unchecked")
                List<Object> nestedList = (List<Object>) item;
                result.add(listToJsonArray(nestedList));
            } else if (item instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> nestedMap = (Map<String, Object>) item;
                result.add(mapToJsonObject(nestedMap));
            } else {
                result.add(item.toString());
            }
        }
        return result;
    }
}
