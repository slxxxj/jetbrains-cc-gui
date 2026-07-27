package com.codeaide.settings;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

/**
 * Unit tests for {@link ProviderManager#mapCcSwitchCodexProvider(JsonObject)}.
 * Covers the pure JSON conversion from cc-switch Codex provider shape
 * ({@code settingsConfig: { auth, config }}) to the plugin's Codex provider
 * structure ({@code configToml} / {@code authJson} raw strings) without Node.js.
 */
public class ProviderManagerCcSwitchCodexTest {

    private static final String SAMPLE_CONFIG_TOML =
            "disable_response_storage = true\n"
                    + "model = \"gpt-5.1-codex\"\n"
                    + "model_reasoning_effort = \"high\"\n"
                    + "model_provider = \"custom\"\n"
                    + "\n"
                    + "[model_providers.custom]\n"
                    + "name = \"Custom\"\n"
                    + "base_url = \"https://codex.example.com/v1\"\n"
                    + "wire_api = \"responses\"\n"
                    + "requires_openai_auth = true\n";

    @Test
    public void shouldMapFullCodexProviderToPluginStructure() {
        JsonObject auth = new JsonObject();
        auth.addProperty("OPENAI_API_KEY", "sk-codex-key");
        JsonObject settingsConfig = new JsonObject();
        settingsConfig.add("auth", auth);
        settingsConfig.addProperty("config", SAMPLE_CONFIG_TOML);

        JsonObject input = new JsonObject();
        input.addProperty("id", "codex-main");
        input.addProperty("name", "Codex Main");
        input.addProperty("source", "cc-switch");
        input.add("settingsConfig", settingsConfig);
        input.addProperty("baseUrl", "https://codex.example.com/v1");
        input.addProperty("apiKey", "sk-codex-key");
        input.addProperty("model", "gpt-5.1-codex");
        input.addProperty("websiteUrl", "https://codex.example.com");
        input.addProperty("remark", "codex remark");
        input.addProperty("createdAt", 1700000002L);
        input.addProperty("updatedAt", 1700000003L);

        JsonObject mapped = ProviderManager.mapCcSwitchCodexProvider(input);

        assertEquals("codex-main", mapped.get("id").getAsString());
        assertEquals("Codex Main", mapped.get("name").getAsString());
        assertEquals("cc-switch", mapped.get("source").getAsString());
        assertEquals("codex remark", mapped.get("remark").getAsString());
        assertEquals("https://codex.example.com", mapped.get("websiteUrl").getAsString());
        assertEquals(1700000002L, mapped.get("createdAt").getAsLong());

        // Raw Codex settings files preserved verbatim for applyProviderToCodexSettings
        assertEquals(SAMPLE_CONFIG_TOML, mapped.get("configToml").getAsString());
        JsonObject mappedAuth = JsonParser.parseString(mapped.get("authJson").getAsString()).getAsJsonObject();
        assertEquals("sk-codex-key", mappedAuth.get("OPENAI_API_KEY").getAsString());

        // cc-switch internals and preview-only fields must not leak into the stored provider
        assertFalse(mapped.has("settingsConfig"));
        assertFalse(mapped.has("apiKey"));
        assertFalse(mapped.has("baseUrl"));
        assertFalse(mapped.has("model"));
        assertFalse(mapped.has("updatedAt"));
    }

    @Test
    public void shouldKeepRawAuthStringWhenAuthIsNotAnObject() {
        JsonObject settingsConfig = new JsonObject();
        settingsConfig.addProperty("auth", "{\"OPENAI_API_KEY\":\"sk-raw\"}");
        settingsConfig.addProperty("config", "model = \"gpt-5\"\n");

        JsonObject input = new JsonObject();
        input.addProperty("id", "codex-raw-auth");
        input.addProperty("name", "Raw Auth");
        input.add("settingsConfig", settingsConfig);

        JsonObject mapped = ProviderManager.mapCcSwitchCodexProvider(input);

        assertEquals("{\"OPENAI_API_KEY\":\"sk-raw\"}", mapped.get("authJson").getAsString());
        assertEquals("model = \"gpt-5\"\n", mapped.get("configToml").getAsString());
    }

    @Test
    public void shouldImportProviderWithoutSettingsConfig() {
        JsonObject input = new JsonObject();
        input.addProperty("id", "codex-empty");
        input.addProperty("name", "Empty");

        JsonObject mapped = ProviderManager.mapCcSwitchCodexProvider(input);

        assertEquals("codex-empty", mapped.get("id").getAsString());
        assertEquals("Empty", mapped.get("name").getAsString());
        assertEquals("cc-switch", mapped.get("source").getAsString());
        assertFalse(mapped.has("configToml"));
        assertFalse(mapped.has("authJson"));
    }

    @Test
    public void shouldIgnoreNonStringConfigField() {
        JsonObject settingsConfig = new JsonObject();
        settingsConfig.add("config", new JsonObject());
        settingsConfig.addProperty("auth", 12345);

        JsonObject input = new JsonObject();
        input.addProperty("id", "codex-obj-config");
        input.addProperty("name", "Object Config");
        input.add("settingsConfig", settingsConfig);

        JsonObject mapped = ProviderManager.mapCcSwitchCodexProvider(input);

        assertFalse(mapped.has("configToml"));
        assertFalse(mapped.has("authJson"));
    }

    @Test
    public void shouldAlwaysMarkImportedProviderAsCcSwitchSource() {
        JsonObject input = new JsonObject();
        input.addProperty("id", "codex-source");
        input.addProperty("name", "Source");
        input.addProperty("source", "something-else");

        JsonObject mapped = ProviderManager.mapCcSwitchCodexProvider(input);

        assertEquals("cc-switch", mapped.get("source").getAsString());
    }
}
