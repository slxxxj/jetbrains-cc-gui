package com.codeaide.provider.codex;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Rewrites Codex {@code config.toml} content so providers whose endpoint only
 * supports Chat Completions ({@code wire_api = "chat"}) are routed through the
 * plugin's built-in local Responses API proxy (ai-bridge/proxy/responses-proxy.mjs).
 *
 * <p>New Codex versions removed the Chat Completions wire API and only speak the
 * Responses API. With this rewrite, a provider declared as {@code wire_api = "chat"}
 * keeps its original meaning ("the upstream speaks Chat Completions") while the
 * effective config the Codex SDK reads points at the localhost proxy with
 * {@code wire_api = "responses"} — the proxy performs the protocol conversion,
 * the same role cc-switch's local router plays.
 *
 * <p>Line-based, comment-aware, dependency-free; fully unit-testable.
 */
public final class CodexConfigTomlRewriter {

    /** Matches a non-comment {@code wire_api = "chat"} line (indentation/trailing comment preserved). */
    private static final Pattern WIRE_API_CHAT_LINE =
            Pattern.compile("^(\\s*wire_api\\s*=\\s*)\"chat\"(\\s*(?:#.*)?)$");

    /** Matches a {@code base_url = "..."} line; group 1 = prefix, group 2 = URL, group 3 = suffix. */
    private static final Pattern BASE_URL_LINE =
            Pattern.compile("^(\\s*base_url\\s*=\\s*\")([^\"]*)(\".*)$");

    private CodexConfigTomlRewriter() {
    }

    /**
     * Returns true when the config declares {@code wire_api = "chat"} on a
     * non-comment line, i.e. the upstream only speaks Chat Completions and the
     * config must be routed through the responses proxy.
     */
    public static boolean needsConversion(String configToml) {
        if (configToml == null) {
            return false;
        }
        for (String line : configToml.split("\n", -1)) {
            if (isCommentLine(line)) {
                continue;
            }
            if (WIRE_API_CHAT_LINE.matcher(stripCarriageReturn(line)).matches()) {
                return true;
            }
        }
        return false;
    }

    /**
     * Extracts the first non-comment {@code base_url} value, or null when absent.
     */
    public static String extractBaseUrl(String configToml) {
        if (configToml == null) {
            return null;
        }
        for (String line : configToml.split("\n", -1)) {
            if (isCommentLine(line)) {
                continue;
            }
            Matcher matcher = BASE_URL_LINE.matcher(stripCarriageReturn(line));
            if (matcher.matches()) {
                return matcher.group(2);
            }
        }
        return null;
    }

    /**
     * Rewrites the config for routing through the local responses proxy:
     * every non-comment {@code wire_api = "chat"} becomes {@code "responses"},
     * and the first non-comment {@code base_url} is pointed at the proxy.
     * Comment lines and everything else are preserved verbatim.
     */
    public static String rewriteForProxy(String configToml, String proxyBaseUrl) {
        if (configToml == null || proxyBaseUrl == null) {
            return configToml;
        }
        String[] lines = configToml.split("\n", -1);
        StringBuilder result = new StringBuilder(configToml.length() + 64);
        boolean baseUrlRewritten = false;
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            String ending = "";
            String content = line;
            if (content.endsWith("\r")) {
                content = content.substring(0, content.length() - 1);
                ending = "\r";
            }

            String rewritten = line;
            if (!isCommentLine(content)) {
                Matcher wireMatcher = WIRE_API_CHAT_LINE.matcher(content);
                if (wireMatcher.matches()) {
                    rewritten = wireMatcher.group(1) + "\"responses\"" + wireMatcher.group(2) + ending;
                } else if (!baseUrlRewritten) {
                    Matcher baseUrlMatcher = BASE_URL_LINE.matcher(content);
                    if (baseUrlMatcher.matches()) {
                        rewritten = baseUrlMatcher.group(1) + proxyBaseUrl + baseUrlMatcher.group(3) + ending;
                        baseUrlRewritten = true;
                    }
                }
            }

            result.append(rewritten);
            if (i < lines.length - 1) {
                result.append('\n');
            }
        }
        return result.toString();
    }

    private static boolean isCommentLine(String line) {
        return line.stripLeading().startsWith("#");
    }

    private static String stripCarriageReturn(String line) {
        return line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
    }
}
