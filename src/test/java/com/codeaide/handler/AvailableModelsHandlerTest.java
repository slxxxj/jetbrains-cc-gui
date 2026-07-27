package com.codeaide.handler;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Contract tests for {@link AvailableModelsHandler} payload shaping. The webview
 * relies on window.updateAvailableModels receiving
 * {provider, models:[{id,label,description}], source:"dynamic"|"fallback"} on
 * every code path, including failures.
 */
public class AvailableModelsHandlerTest {

    @Test
    public void shouldKeepDynamicSourceWhenDaemonReturnsModels() {
        JsonObject daemonPayload = JsonParser.parseString(
                "{\"provider\":\"codex\",\"models\":[{\"id\":\"gpt-5.6\",\"label\":\"GPT-5.6\",\"description\":\"d\"}],"
                        + "\"source\":\"dynamic\"}").getAsJsonObject();

        JsonObject result = AvailableModelsHandler.sanitizePayload("codex", daemonPayload);

        assertEquals("codex", result.get("provider").getAsString());
        assertEquals("dynamic", result.get("source").getAsString());
        assertEquals(1, result.getAsJsonArray("models").size());
    }

    @Test
    public void shouldEchoRequestedProviderOverDaemonPayload() {
        JsonObject daemonPayload = JsonParser.parseString(
                "{\"provider\":\"claude\",\"models\":[{\"id\":\"m\"}],\"source\":\"dynamic\"}").getAsJsonObject();

        JsonObject result = AvailableModelsHandler.sanitizePayload("codex", daemonPayload);

        assertEquals("codex", result.get("provider").getAsString());
    }

    @Test
    public void shouldFallbackWhenModelsMissingOrNotArray() {
        JsonObject result = AvailableModelsHandler.sanitizePayload("claude", JsonParser.parseString(
                "{\"provider\":\"claude\",\"source\":\"dynamic\"}").getAsJsonObject());

        assertEquals("fallback", result.get("source").getAsString());
        assertTrue(result.get("models").isJsonArray());
        assertEquals(0, result.getAsJsonArray("models").size());
    }

    @Test
    public void shouldDowngradeDynamicWithEmptyModelsToFallback() {
        JsonObject result = AvailableModelsHandler.sanitizePayload("codex", JsonParser.parseString(
                "{\"provider\":\"codex\",\"models\":[],\"source\":\"dynamic\"}").getAsJsonObject());

        assertEquals("fallback", result.get("source").getAsString());
    }

    @Test
    public void shouldFallbackOnNullOrUnknownSource() {
        JsonObject fromNull = AvailableModelsHandler.sanitizePayload("claude", null);
        assertEquals("fallback", fromNull.get("source").getAsString());
        assertEquals(0, fromNull.getAsJsonArray("models").size());

        JsonObject weird = AvailableModelsHandler.sanitizePayload("claude", JsonParser.parseString(
                "{\"models\":[{\"id\":\"m\"}],\"source\":\"weird\"}").getAsJsonObject());
        assertEquals("fallback", weird.get("source").getAsString());
    }

    @Test
    public void fallbackPayloadShouldMatchContract() {
        JsonObject payload = AvailableModelsHandler.buildFallbackPayload("codex", "boom");

        assertEquals("codex", payload.get("provider").getAsString());
        assertEquals("fallback", payload.get("source").getAsString());
        assertTrue(payload.get("models").isJsonArray());
        assertEquals(0, payload.getAsJsonArray("models").size());
        assertEquals("boom", payload.get("error").getAsString());

        JsonObject noError = AvailableModelsHandler.buildFallbackPayload("claude", null);
        assertFalse(noError.has("error"));
    }

    @Test
    public void shouldPreserveDaemonErrorFieldThroughSanitize() {
        JsonArray empty = new JsonArray();
        JsonObject daemonPayload = new JsonObject();
        daemonPayload.addProperty("provider", "claude");
        daemonPayload.add("models", empty);
        daemonPayload.addProperty("source", "fallback");
        daemonPayload.addProperty("error", "HTTP 401");

        JsonObject result = AvailableModelsHandler.sanitizePayload("claude", daemonPayload);

        assertEquals("fallback", result.get("source").getAsString());
        assertEquals("HTTP 401", result.get("error").getAsString());
    }
}
