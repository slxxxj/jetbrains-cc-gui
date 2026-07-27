package com.codeaide.provider.common;

/**
 * Declares which optional capabilities a provider supports.
 *
 * <p>Values describe the current reality of each provider adapter — a missing
 * capability is reported as {@code false} rather than emulated. Callers are
 * expected to gate provider-specific behavior behind these flags instead of
 * comparing provider name strings.
 */
public final class ProviderCapabilities {

    private final boolean daemon;
    private final boolean livePermissionMode;
    private final boolean rewind;
    private final boolean contextUsage;
    private final boolean serviceTier;

    public ProviderCapabilities(
            boolean daemon,
            boolean livePermissionMode,
            boolean rewind,
            boolean contextUsage,
            boolean serviceTier
    ) {
        this.daemon = daemon;
        this.livePermissionMode = livePermissionMode;
        this.rewind = rewind;
        this.contextUsage = contextUsage;
        this.serviceTier = serviceTier;
    }

    /**
     * Whether the provider keeps a persistent daemon runtime that can be
     * prewarmed, reset and shut down (Claude only; Codex runs per-process).
     */
    public boolean supportsDaemon() {
        return daemon;
    }

    /**
     * Whether the provider can hot-swap the permission mode on a live runtime
     * mid-turn (Claude only; Codex rebuilds thread options per turn).
     */
    public boolean supportsLivePermissionMode() {
        return livePermissionMode;
    }

    /**
     * Whether the provider supports rewinding files to a previous user message.
     */
    public boolean supportsRewind() {
        return rewind;
    }

    /**
     * Whether the provider can report a context-window usage breakdown.
     */
    public boolean supportsContextUsage() {
        return contextUsage;
    }

    /**
     * Whether the provider accepts a service-tier selection on send
     * (Codex "fast" tier; Claude has no equivalent).
     */
    public boolean supportsServiceTier() {
        return serviceTier;
    }
}
