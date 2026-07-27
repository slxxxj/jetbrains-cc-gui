package com.codeaide.util;

import com.intellij.openapi.diagnostic.Logger;
import org.cef.CefApp;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.callback.CefCallback;
import org.cef.callback.CefSchemeHandlerFactory;
import org.cef.handler.CefResourceHandler;
import org.cef.handler.CefResourceHandlerAdapter;
import org.cef.misc.IntRef;
import org.cef.misc.StringRef;
import org.cef.network.CefRequest;
import org.cef.network.CefResponse;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Serves lazy-loaded webview asset chunks (e.g. the mermaid bundle) to JCEF.
 *
 * The chat page is loaded via {@code JBCefBrowser.loadHTML()}, which places the
 * document under a {@code file:///jbcefbrowser/...} URL with an opaque origin.
 * Relative URLs therefore cannot resolve sibling resources from the plugin
 * classpath, so the vite build emits dynamic-import chunks with an absolute
 * {@code https://codeaide-webview.invalid/...} URL (see webview/vite.config.ts).
 * This handler intercepts requests for that origin and answers them from the
 * {@code /html/assets/} classpath resources copied there by copy-dist.mjs.
 *
 * https is used (not file) so the ES-module chunk passes Chromium's module
 * loading rules; the Access-Control-Allow-Origin header lets the opaque-origin
 * page import the chunk cross-origin.
 */
public final class WebviewAssetSchemeHandler implements CefSchemeHandlerFactory {

    public static final String SCHEME = "https";
    public static final String DOMAIN = "codeaide-webview.invalid";
    public static final String ORIGIN = SCHEME + "://" + DOMAIN;

    private static final Logger LOG = Logger.getInstance(WebviewAssetSchemeHandler.class);
    private static final String RESOURCE_ROOT = "/html";
    private static final String ASSET_PATH_PREFIX = "/assets/";
    private static final AtomicBoolean REGISTERED = new AtomicBoolean(false);
    private static final Map<String, byte[]> CONTENT_CACHE = new ConcurrentHashMap<>();

    /**
     * Register the scheme handler factory with CEF exactly once.
     *
     * Must be called only after a JBCefBrowser has been created (i.e. JBCefApp
     * is initialized); otherwise CefApp.getInstance() would initialize CEF with
     * default settings that conflict with JBCefApp's configuration. A failure
     * here is not fatal: the mermaid chunk simply fails to load and the
     * frontend falls back to rendering the diagram source as a code block.
     */
    public static void ensureRegistered() {
        if (!REGISTERED.compareAndSet(false, true)) {
            return;
        }
        try {
            boolean ok = CefApp.getInstance().registerSchemeHandlerFactory(
                    SCHEME, DOMAIN, new WebviewAssetSchemeHandler());
            if (ok) {
                LOG.info("Registered webview asset scheme handler for " + ORIGIN);
            } else {
                REGISTERED.set(false);
                LOG.warn("CEF rejected webview asset scheme handler registration for " + ORIGIN);
            }
        } catch (Exception | LinkageError e) {
            REGISTERED.set(false);
            LOG.warn("Failed to register webview asset scheme handler: " + e.getMessage());
        }
    }

    @Override
    public CefResourceHandler create(CefBrowser browser, CefFrame frame,
                                     String schemeName, CefRequest request) {
        if (!SCHEME.equals(schemeName) || request == null || request.getURL() == null) {
            return null;
        }
        String path = extractPath(request.getURL());
        if (path == null || !path.startsWith(ASSET_PATH_PREFIX) || path.contains("..")) {
            return null;
        }
        byte[] content = loadResource(path);
        if (content == null) {
            LOG.warn("Webview asset not found in plugin resources: " + path);
            return new AssetResourceHandler(new byte[0], "text/plain", 404);
        }
        return new AssetResourceHandler(content, mimeTypeFor(path), 200);
    }

    /**
     * Strip the origin from the request URL, returning the path portion
     * (without query or fragment), or null if the URL is not on our origin.
     */
    private static String extractPath(String url) {
        if (!url.startsWith(ORIGIN)) {
            return null;
        }
        String path = url.substring(ORIGIN.length());
        int queryIndex = path.indexOf('?');
        if (queryIndex >= 0) {
            path = path.substring(0, queryIndex);
        }
        int fragmentIndex = path.indexOf('#');
        if (fragmentIndex >= 0) {
            path = path.substring(0, fragmentIndex);
        }
        return path;
    }

    /**
     * Load an asset chunk from the plugin classpath (/html/assets/...).
     * Content is static per plugin version, so it is cached in memory.
     */
    private static byte[] loadResource(String path) {
        byte[] cached = CONTENT_CACHE.get(path);
        if (cached != null) {
            return cached;
        }
        try (InputStream is = WebviewAssetSchemeHandler.class.getResourceAsStream(RESOURCE_ROOT + path)) {
            if (is == null) {
                return null;
            }
            byte[] content = is.readAllBytes();
            CONTENT_CACHE.put(path, content);
            return content;
        } catch (Exception e) {
            LOG.warn("Failed to read webview asset resource " + path + ": " + e.getMessage());
            return null;
        }
    }

    private static String mimeTypeFor(String path) {
        if (path.endsWith(".js") || path.endsWith(".mjs")) {
            return "text/javascript";
        }
        if (path.endsWith(".css")) {
            return "text/css";
        }
        if (path.endsWith(".map")) {
            return "application/json";
        }
        return "application/octet-stream";
    }

    /**
     * Resource handler that answers a request from an in-memory byte array.
     * Modeled after the platform's JBCefLoadHtmlResourceHandler.
     */
    private static final class AssetResourceHandler extends CefResourceHandlerAdapter {
        private final ByteArrayInputStream stream;
        private final int length;
        private final String mimeType;
        private final int status;

        AssetResourceHandler(byte[] content, String mimeType, int status) {
            this.stream = new ByteArrayInputStream(content);
            this.length = content.length;
            this.mimeType = mimeType;
            this.status = status;
        }

        @Override
        public boolean processRequest(CefRequest request, CefCallback callback) {
            callback.Continue();
            return true;
        }

        @Override
        public void getResponseHeaders(CefResponse response, IntRef responseLength,
                                       StringRef redirectUrl) {
            response.setStatus(status);
            response.setMimeType(mimeType);
            response.setHeaderByName("Access-Control-Allow-Origin", "*", true);
            response.setHeaderByName("Cache-Control", "no-cache", true);
            responseLength.set(length);
        }

        @Override
        public boolean readResponse(byte[] dataOut, int bytesToRead,
                                    IntRef bytesRead, CefCallback callback) {
            int available = stream.available();
            if (available <= 0) {
                bytesRead.set(0);
                return false;
            }
            int toCopy = Math.min(bytesToRead, available);
            int copied = stream.read(dataOut, 0, toCopy);
            bytesRead.set(copied);
            return copied > 0;
        }
    }
}
