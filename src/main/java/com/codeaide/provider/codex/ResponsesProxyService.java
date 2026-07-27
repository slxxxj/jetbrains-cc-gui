package com.codeaide.provider.codex;

import com.codeaide.bridge.BridgeDirectoryResolver;
import com.codeaide.bridge.EnvironmentConfigurator;
import com.codeaide.bridge.NodeDetector;
import com.codeaide.startup.BridgePreloader;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Manages the built-in Responses API → Chat Completions conversion proxy
 * (ai-bridge/proxy/responses-proxy.mjs), a tiny localhost Node HTTP server.
 *
 * <p>New Codex versions only speak the Responses API, while many third-party
 * providers (Kimi, GLM, ...) only offer Chat Completions. When a Codex provider
 * declares {@code wire_api = "chat"}, {@link CodexSettingsManager} points the
 * effective config.toml at this proxy instead (see {@link CodexConfigTomlRewriter})
 * and the proxy converts protocols on the fly — the same role cc-switch's local
 * router plays.
 *
 * <p>Application-level singleton: one proxy process per IDE instance. The upstream
 * is reconfigured at runtime via the proxy's {@code POST /__config} endpoint, so
 * switching Codex providers never requires a proxy restart. API keys are never
 * sent to or stored by the proxy manager — Codex's {@code Authorization} header
 * is forwarded by the proxy verbatim.
 */
public final class ResponsesProxyService {

    private static final Logger LOG = Logger.getInstance(ResponsesProxyService.class);

    private static final String PROXY_SCRIPT_PATH = "proxy/responses-proxy.mjs";
    private static final String READY_PREFIX = "RESPONSES_PROXY_READY ";
    private static final long READY_TIMEOUT_MILLIS = 15_000;
    private static final long CONFIG_TIMEOUT_MILLIS = 5_000;

    private static volatile ResponsesProxyService instance;
    private static final Object INSTANCE_LOCK = new Object();

    private final Object lifecycleLock = new Object();
    private Process process;
    private int port = -1;
    /** The upstream the running proxy is currently configured with. */
    private String configuredUpstream;
    private final AtomicBoolean shutdownHookRegistered = new AtomicBoolean(false);

    private ResponsesProxyService() {
    }

    public static ResponsesProxyService getInstance() {
        if (instance == null) {
            synchronized (INSTANCE_LOCK) {
                if (instance == null) {
                    instance = new ResponsesProxyService();
                }
            }
        }
        return instance;
    }

    /**
     * Ensures the proxy process is running and configured with the given upstream
     * base URL, and returns the local base URL Codex should use
     * ({@code http://127.0.0.1:<port>/v1}). Returns {@code null} on any failure —
     * callers must fall back to writing the provider config unmodified.
     */
    public String ensureRunningAndConfigure(String upstreamBaseUrl) {
        synchronized (lifecycleLock) {
            try {
                if (!isAlive() && !startLocked()) {
                    return null;
                }
                if (upstreamBaseUrl != null && !upstreamBaseUrl.equals(configuredUpstream)) {
                    if (!postUpstreamConfigLocked(upstreamBaseUrl)) {
                        stopLocked();
                        return null;
                    }
                    configuredUpstream = upstreamBaseUrl;
                }
                return "http://127.0.0.1:" + port + "/v1";
            } catch (Exception e) {
                LOG.warn("[ResponsesProxy] ensureRunningAndConfigure failed: " + e.getMessage(), e);
                stopLocked();
                return null;
            }
        }
    }

    /** Stops the proxy process (e.g. on plugin dispose). */
    public void stop() {
        synchronized (lifecycleLock) {
            stopLocked();
        }
    }

    // ==================== Internals (all called under lifecycleLock) ====================

    private boolean isAlive() {
        return process != null && process.isAlive() && port > 0;
    }

    private boolean startLocked() {
        try {
            BridgeDirectoryResolver resolver = BridgePreloader.getSharedResolver();
            File bridgeDir = resolver != null ? resolver.findSdkDir() : null;
            if (bridgeDir == null) {
                LOG.warn("[ResponsesProxy] Bridge directory not found");
                return false;
            }
            File script = new File(bridgeDir, PROXY_SCRIPT_PATH.replace('/', File.separatorChar));
            if (!script.exists()) {
                LOG.warn("[ResponsesProxy] Proxy script not found at: " + script.getAbsolutePath());
                return false;
            }
            String nodePath = NodeDetector.getInstance().findNodeExecutable();
            if (nodePath == null) {
                LOG.warn("[ResponsesProxy] Node.js not found");
                return false;
            }

            List<String> command = NodeDetector.buildNodeScriptCommand(nodePath, script.getAbsolutePath());
            command.add("--port");
            command.add("0");

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(bridgeDir);
            new EnvironmentConfigurator().updateProcessEnvironment(pb, nodePath);
            pb.redirectErrorStream(false);

            process = pb.start();
            registerShutdownHook();
            LOG.info("[ResponsesProxy] Proxy process started, PID: " + process.pid());

            CountDownLatch readyLatch = new CountDownLatch(1);
            AtomicReference<String> readyLine = new AtomicReference<>();
            startStdoutReader(process, readyLatch, readyLine);
            startStderrGobbler(process);

            boolean ready = readyLatch.await(READY_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
            if (!ready || readyLine.get() == null) {
                LOG.warn("[ResponsesProxy] Proxy did not signal ready within " + READY_TIMEOUT_MILLIS + "ms");
                stopLocked();
                return false;
            }

            JsonObject readyJson = JsonParser.parseString(readyLine.get().substring(READY_PREFIX.length()))
                    .getAsJsonObject();
            port = readyJson.get("port").getAsInt();
            configuredUpstream = null;
            LOG.info("[ResponsesProxy] Proxy listening on 127.0.0.1:" + port);
            return true;
        } catch (Exception e) {
            LOG.warn("[ResponsesProxy] Failed to start proxy: " + e.getMessage(), e);
            stopLocked();
            return false;
        }
    }

    private void stopLocked() {
        if (process != null) {
            try {
                process.destroy();
                if (!process.waitFor(2, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            } catch (Exception e) {
                LOG.debug("[ResponsesProxy] Error stopping proxy: " + e.getMessage());
            }
            process = null;
        }
        port = -1;
        configuredUpstream = null;
    }

    private boolean postUpstreamConfigLocked(String upstreamBaseUrl) {
        try {
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofMillis(CONFIG_TIMEOUT_MILLIS))
                    .build();
            JsonObject body = new JsonObject();
            body.addProperty("upstream", upstreamBaseUrl);
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + port + "/__config"))
                    .timeout(Duration.ofMillis(CONFIG_TIMEOUT_MILLIS))
                    .header("content-type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 200) {
                LOG.info("[ResponsesProxy] Upstream configured: " + upstreamBaseUrl);
                return true;
            }
            LOG.warn("[ResponsesProxy] Proxy rejected upstream config, status=" + response.statusCode()
                    + " body=" + response.body());
            return false;
        } catch (Exception e) {
            LOG.warn("[ResponsesProxy] Failed to configure upstream: " + e.getMessage());
            return false;
        }
    }

    /** Drains stdout; captures the READY line then keeps draining to avoid pipe blocking. */
    private void startStdoutReader(Process target, CountDownLatch readyLatch, AtomicReference<String> readyLine) {
        Thread reader = new Thread(() -> {
            try (BufferedReader in = new BufferedReader(
                    new InputStreamReader(target.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = in.readLine()) != null) {
                    if (line.startsWith(READY_PREFIX)) {
                        readyLine.set(line);
                        readyLatch.countDown();
                    } else {
                        LOG.debug("[ResponsesProxy] " + line);
                    }
                }
            } catch (Exception e) {
                LOG.debug("[ResponsesProxy] stdout reader ended: " + e.getMessage());
            } finally {
                readyLatch.countDown();
            }
        }, "responses-proxy-stdout");
        reader.setDaemon(true);
        reader.start();
    }

    private void startStderrGobbler(Process target) {
        Thread gobbler = new Thread(() -> {
            try (BufferedReader in = new BufferedReader(
                    new InputStreamReader(target.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = in.readLine()) != null) {
                    LOG.debug("[ResponsesProxy][stderr] " + line);
                }
            } catch (Exception ignored) {
            }
        }, "responses-proxy-stderr");
        gobbler.setDaemon(true);
        gobbler.start();
    }

    /** Ensures the proxy child process does not outlive the IDE on a normal shutdown. */
    private void registerShutdownHook() {
        if (shutdownHookRegistered.compareAndSet(false, true)) {
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                try {
                    Process current = process;
                    if (current != null && current.isAlive()) {
                        current.destroy();
                    }
                } catch (Exception ignored) {
                }
            }, "responses-proxy-shutdown"));
        }
    }
}
