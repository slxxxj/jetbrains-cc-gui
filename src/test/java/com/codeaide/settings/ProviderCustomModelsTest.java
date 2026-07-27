package com.codeaide.settings;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests that the provider customModels array (user-defined model entries shown
 * in the model selector: [{"id","label"?,"description"?}]) survives the
 * provider save/read/update round-trip through ~/.codeaide/config.json.
 * Providers are passed through as opaque JsonObjects end-to-end; these tests
 * guard that contract for both Claude and Codex provider managers.
 */
public class ProviderCustomModelsTest {

    private static final String CUSTOM_MODELS_JSON =
            "[{\"id\":\"my-model\",\"label\":\"My Model\",\"description\":\"fine-tuned\"},{\"id\":\"bare-model\"}]";

    // ==========================================================================
    // Claude (ProviderManager)
    // ==========================================================================

    @Test
    public void claudeSaveProviderShouldPreserveCustomModels() throws Exception {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(new JsonObject());
        ProviderManager manager = createClaudeManager(configRef);

        JsonObject provider = newProvider("p1", true);
        manager.saveClaudeProvider(provider);

        JsonObject stored = findProvider(manager.getClaudeProviders(), "p1");
        assertNotNull(stored);
        assertEquals(CUSTOM_MODELS_JSON, stored.getAsJsonArray("customModels").toString());

        // The raw config written to disk must carry the array untouched.
        JsonObject raw = configRef.get()
                .getAsJsonObject("claude").getAsJsonObject("providers").getAsJsonObject("p1");
        assertEquals(CUSTOM_MODELS_JSON, raw.getAsJsonArray("customModels").toString());
    }

    @Test
    public void claudeUpdateProviderShouldMergeAndRemoveCustomModels() throws Exception {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(new JsonObject());
        ProviderManager manager = createClaudeManager(configRef);
        manager.saveClaudeProvider(newProvider("p1", false));

        JsonObject updates = new JsonObject();
        updates.add("customModels", JsonParser.parseString(CUSTOM_MODELS_JSON));
        manager.updateClaudeProvider("p1", updates);
        assertEquals(CUSTOM_MODELS_JSON,
                findProvider(manager.getClaudeProviders(), "p1").getAsJsonArray("customModels").toString());

        // JsonNull removes the field (existing update-merge semantics).
        JsonObject removal = new JsonObject();
        removal.add("customModels", JsonNull.INSTANCE);
        manager.updateClaudeProvider("p1", removal);
        assertFalse(findProvider(manager.getClaudeProviders(), "p1").has("customModels"));
    }

    @Test
    public void claudeActiveProviderShouldCarryCustomModels() throws Exception {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(new JsonObject());
        ProviderManager manager = createClaudeManager(configRef);
        manager.saveClaudeProvider(newProvider("p1", true));
        manager.switchClaudeProvider("p1");

        JsonObject active = manager.getActiveClaudeProvider();
        assertNotNull(active);
        assertTrue(active.has("customModels"));
        assertEquals(2, active.getAsJsonArray("customModels").size());
    }

    // ==========================================================================
    // Codex (CodexProviderManager)
    // ==========================================================================

    @Test
    public void codexSaveProviderShouldPreserveCustomModels() throws Exception {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(new JsonObject());
        CodexProviderManager manager = createCodexManager(configRef);

        manager.saveCodexProvider(newProvider("cx1", true));

        JsonObject stored = findProvider(manager.getCodexProviders(), "cx1");
        assertNotNull(stored);
        assertEquals(CUSTOM_MODELS_JSON, stored.getAsJsonArray("customModels").toString());

        JsonObject raw = configRef.get()
                .getAsJsonObject("codex").getAsJsonObject("providers").getAsJsonObject("cx1");
        assertEquals(CUSTOM_MODELS_JSON, raw.getAsJsonArray("customModels").toString());
    }

    @Test
    public void codexUpdateProviderShouldMergeAndRemoveCustomModels() throws Exception {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(new JsonObject());
        CodexProviderManager manager = createCodexManager(configRef);
        manager.saveCodexProvider(newProvider("cx1", false));

        JsonObject updates = new JsonObject();
        updates.add("customModels", JsonParser.parseString(CUSTOM_MODELS_JSON));
        manager.updateCodexProvider("cx1", updates);
        assertEquals(CUSTOM_MODELS_JSON,
                findProvider(manager.getCodexProviders(), "cx1").getAsJsonArray("customModels").toString());

        JsonObject removal = new JsonObject();
        removal.add("customModels", JsonNull.INSTANCE);
        manager.updateCodexProvider("cx1", removal);
        assertFalse(findProvider(manager.getCodexProviders(), "cx1").has("customModels"));
    }

    @Test
    public void codexActiveProviderShouldCarryCustomModels() throws Exception {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(new JsonObject());
        CodexProviderManager manager = createCodexManager(configRef);
        manager.saveCodexProvider(newProvider("cx1", true));
        manager.switchCodexProvider("cx1");

        JsonObject active = manager.getActiveCodexProvider();
        assertNotNull(active);
        assertTrue(active.has("customModels"));
        assertEquals("my-model", active.getAsJsonArray("customModels").get(0).getAsJsonObject().get("id").getAsString());
    }

    // ==========================================================================
    // Helpers
    // ==========================================================================

    private static JsonObject newProvider(String id, boolean withCustomModels) {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", id);
        provider.addProperty("name", "Provider " + id);
        if (withCustomModels) {
            JsonArray customModels = JsonParser.parseString(CUSTOM_MODELS_JSON).getAsJsonArray();
            provider.add("customModels", customModels);
        }
        return provider;
    }

    private static JsonObject findProvider(List<JsonObject> providers, String id) {
        for (JsonObject provider : providers) {
            if (id.equals(provider.get("id").getAsString())) {
                return provider;
            }
        }
        return null;
    }

    private static ProviderManager createClaudeManager(AtomicReference<JsonObject> configRef) {
        Gson gson = new Gson();
        ClaudeSettingsManager claudeSettingsManager = new ClaudeSettingsManager(gson, null) {
            @Override
            public JsonObject readClaudeSettings() {
                JsonObject settings = new JsonObject();
                settings.add("env", new JsonObject());
                return settings;
            }
        };
        return new ProviderManager(
                gson,
                ignored -> configRef.get(),
                updated -> configRef.set(JsonParser.parseString(updated.toString()).getAsJsonObject()),
                null,
                claudeSettingsManager
        );
    }

    private static CodexProviderManager createCodexManager(AtomicReference<JsonObject> configRef) {
        Gson gson = new Gson();
        return new CodexProviderManager(
                gson,
                ignored -> configRef.get(),
                updated -> configRef.set(JsonParser.parseString(updated.toString()).getAsJsonObject()),
                null,
                null
        );
    }
}
