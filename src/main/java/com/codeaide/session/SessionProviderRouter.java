package com.codeaide.session;

import com.codeaide.provider.claude.ClaudeProviderOps;
import com.codeaide.provider.claude.ClaudeSDKBridge;
import com.codeaide.provider.codex.CodexProviderOps;
import com.codeaide.provider.codex.CodexSDKBridge;
import com.codeaide.provider.common.ProviderOps;
import com.google.gson.JsonObject;

import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Registry of per-provider operations for session routing.
 *
 * <p>Replaces the former string-based if/else dispatch: providers are looked
 * up in a {@code Map<String, ProviderOps>} and self-describe their optional
 * behavior through {@link ProviderOps#capabilities()}. Unknown or null
 * provider names fall back to the default (claude) provider, matching the
 * legacy "anything that is not codex routes to claude" behavior.
 */
public class SessionProviderRouter {

    /**
     * Provider used when the requested name is unknown or null.
     */
    public static final String DEFAULT_PROVIDER = "claude";

    private final Map<String, ProviderOps> providers = new LinkedHashMap<>();

    public SessionProviderRouter(ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge) {
        register(new ClaudeProviderOps(claudeSDKBridge));
        register(new CodexProviderOps(codexSDKBridge));
    }

    /**
     * Register (or replace) a provider's operations under its name.
     */
    public final void register(ProviderOps ops) {
        providers.put(ops.getProviderName(), ops);
    }

    /**
     * Look up the operations for a provider name. Falls back to the default
     * provider when the name is unknown or null.
     */
    public ProviderOps ops(String provider) {
        ProviderOps ops = provider != null ? providers.get(provider) : null;
        if (ops == null) {
            ops = providers.get(DEFAULT_PROVIDER);
        }
        return ops;
    }

    /**
     * All registered provider operations, in registration order.
     */
    public Collection<ProviderOps> all() {
        return Collections.unmodifiableCollection(providers.values());
    }

    public JsonObject launchChannel(String provider, String channelId, String sessionId, String cwd) {
        return ops(provider).launchChannel(channelId, sessionId, cwd);
    }

    public void interruptChannel(String provider, String channelId) {
        ops(provider).interruptChannel(channelId);
    }

    public List<JsonObject> getSessionMessages(String provider, String sessionId, String cwd) {
        return ops(provider).getSessionMessages(sessionId, cwd);
    }
}
