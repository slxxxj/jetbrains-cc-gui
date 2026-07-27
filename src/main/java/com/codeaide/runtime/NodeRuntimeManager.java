package com.codeaide.runtime;

import com.codeaide.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Manages a plugin-owned, fully isolated Node.js runtime under
 * {@code ~/.codeaide/runtime/node/} (design: docs/plans/sdk-autoinstall-provider-isolation-dynamic-models.md,
 * 方案一 · 第 0 条 "Node 运行时自举").
 *
 * <p>When no usable system Node.js is found, the plugin silently downloads an official
 * prebuilt archive (~30MB, no installer / admin rights / PATH changes needed) and extracts
 * it into the plugin's own directory. The runtime is only ever invoked by absolute path,
 * stays invisible to the system Node.js, and is never affected by system Node upgrades.</p>
 *
 * <p>Directory layout (version and platform are pinned by constants):</p>
 * <pre>
 *   ~/.codeaide/runtime/node/
 *     node-v22.14.0-win-x64/node.exe            (Windows)
 *     node-v22.14.0-darwin-arm64/bin/node       (macOS Apple Silicon)
 *     node-v22.14.0-darwin-x64/bin/node         (macOS Intel)
 *     node-v22.14.0-linux-x64/bin/node          (Linux x64)
 * </pre>
 *
 * <p>Failure semantics: downloads/extractions happen into unique temp siblings and are
 * moved into place only after success, so any failure cleans up partial files and never
 * breaks a previously installed runtime.</p>
 *
 * <p><b>Phase 1B integration point:</b> call {@link #ensureRuntime()} once during plugin
 * startup (e.g. from a {@code ProjectActivity} such as {@code BridgePreloader}) on a
 * background thread. It is idempotent, thread-safe and asynchronous — repeat calls while
 * an install is in flight share the same future. {@code NodeDetector} already prefers the
 * managed runtime during auto-detection and kicks off {@code ensureRuntime()} itself when
 * no system Node.js is found; the startup call exists to make the bootstrap explicit and
 * to surface the result to later phases (e.g. clearing stale NodeDetector caches).</p>
 */
public class NodeRuntimeManager {

    private static final Logger LOG = Logger.getInstance(NodeRuntimeManager.class);

    /** Pinned Node.js version (22.x LTS "Jod"). Bump deliberately, together with tests. */
    public static final String NODE_VERSION = "22.14.0";

    /** Official Node.js distribution site (default download source). */
    public static final String DEFAULT_DIST_BASE_URL = "https://nodejs.org/dist/";

    /** npmmirror binary mirror — fallback for networks with poor access to nodejs.org. */
    public static final String NPMMIRROR_DIST_BASE_URL = "https://registry.npmmirror.com/-/binary/node/";

    /**
     * System property overriding the download source. Accepts a full base URL, or the
     * literal value {@code "npmmirror"} as a shorthand for {@link #NPMMIRROR_DIST_BASE_URL}.
     * Example: {@code -Dcodeaide.node.dist.baseUrl=npmmirror}
     */
    public static final String DIST_BASE_URL_PROPERTY = "codeaide.node.dist.baseUrl";

    private static final int CONNECT_TIMEOUT_SECONDS = 30;
    private static final int VERIFY_TIMEOUT_SECONDS = 10;

    /**
     * Platform/os-arch combinations for which an official prebuilt Node.js archive exists.
     * The {@code distKey} matches the nodejs.org/dist naming scheme.
     */
    public enum NodePlatform {
        /** Windows x64 (.zip, node.exe at archive root) */
        WIN_X64("win-x64", "zip"),
        /** macOS Intel (.tar.gz) */
        MAC_X64("darwin-x64", "tar.gz"),
        /** macOS Apple Silicon (.tar.gz) */
        MAC_ARM64("darwin-arm64", "tar.gz"),
        /** Linux x64 (.tar.gz) */
        LINUX_X64("linux-x64", "tar.gz");

        private final String distKey;
        private final String archiveExtension;

        NodePlatform(String distKey, String archiveExtension) {
            this.distKey = distKey;
            this.archiveExtension = archiveExtension;
        }

        /** Key used in archive file names, e.g. "darwin-arm64". */
        public String getDistKey() {
            return distKey;
        }
    }

    // ============================================================================
    // Pure helpers (static, unit-testable)
    // ============================================================================

    /**
     * Maps an os.name/os.arch pair to a supported platform.
     *
     * @return the matching platform, or null when no official prebuilt archive exists
     *         (e.g. Windows ARM64, Linux ARM) — callers must treat null as "unsupported"
     */
    static NodePlatform detectPlatform(String osName, String osArch) {
        String os = osName == null ? "" : osName.toLowerCase(Locale.ROOT);
        String arch = osArch == null ? "" : osArch.toLowerCase(Locale.ROOT);
        boolean x64 = arch.equals("amd64") || arch.equals("x86_64");
        boolean arm64 = arch.equals("aarch64") || arch.equals("arm64");

        if (os.contains("win")) {
            return x64 ? NodePlatform.WIN_X64 : null;
        }
        if (os.contains("mac") || os.contains("darwin")) {
            if (arm64) {
                return NodePlatform.MAC_ARM64;
            }
            return x64 ? NodePlatform.MAC_X64 : null;
        }
        if (os.contains("linux") || os.contains("nix") || os.contains("nux")) {
            return x64 ? NodePlatform.LINUX_X64 : null;
        }
        return null;
    }

    /** Directory name of the extracted runtime, e.g. "node-v22.14.0-win-x64". */
    static String runtimeDirName(NodePlatform platform) {
        return "node-v" + NODE_VERSION + "-" + platform.getDistKey();
    }

    /** Archive file name on the dist server, e.g. "node-v22.14.0-darwin-arm64.tar.gz". */
    static String archiveFileName(NodePlatform platform) {
        return runtimeDirName(platform) + "." + platform.archiveExtension;
    }

    /**
     * Full download URL following the nodejs.org/dist layout
     * ({@code <base>/v<version>/<archive>}); the npmmirror binary mirror uses the same layout.
     */
    static String downloadUrl(String baseUrl, NodePlatform platform) {
        String base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
        return base + "v" + NODE_VERSION + "/" + archiveFileName(platform);
    }

    /** Resolves the effective download base URL (system property override, else official dist). */
    static String resolveDistBaseUrl() {
        String override = System.getProperty(DIST_BASE_URL_PROPERTY);
        if (override == null || override.trim().isEmpty()) {
            return DEFAULT_DIST_BASE_URL;
        }
        String trimmed = override.trim();
        if ("npmmirror".equalsIgnoreCase(trimmed)) {
            return NPMMIRROR_DIST_BASE_URL;
        }
        return trimmed;
    }

    // ============================================================================
    // Singleton
    // ============================================================================

    private static volatile NodeRuntimeManager instance;

    /** Returns the shared instance rooted at {@code ~/.codeaide/runtime/node/}. */
    public static NodeRuntimeManager getInstance() {
        if (instance == null) {
            synchronized (NodeRuntimeManager.class) {
                if (instance == null) {
                    instance = new NodeRuntimeManager(
                            Paths.get(PlatformUtils.getHomeDirectory(), ".codeaide", "runtime", "node"),
                            detectPlatform(System.getProperty("os.name", ""), System.getProperty("os.arch", ""))
                    );
                }
            }
        }
        return instance;
    }

    // ============================================================================
    // Instance
    // ============================================================================

    private final Path baseDir;
    /** Current platform, or null when no prebuilt archive exists for this OS/arch. */
    private final NodePlatform platform;
    private final Object installLock = new Object();
    private volatile CompletableFuture<Path> inFlightInstall;

    /** Package-private constructor with injectable base dir / platform for tests. */
    NodeRuntimeManager(Path baseDir, NodePlatform platform) {
        this.baseDir = baseDir;
        this.platform = platform;
    }

    /** Root directory of the managed runtime area ({@code ~/.codeaide/runtime/node}). */
    public Path getBaseDir() {
        return baseDir;
    }

    /** Directory the pinned runtime extracts to; null on unsupported platforms. */
    public Path getRuntimeHomeDir() {
        return platform == null ? null : baseDir.resolve(runtimeDirName(platform));
    }

    /**
     * Expected path of the managed node executable (whether or not it exists yet).
     * Windows: {@code <home>/node.exe}; Unix: {@code <home>/bin/node}.
     * Null on unsupported platforms.
     */
    public Path getNodeExecutablePath() {
        Path home = getRuntimeHomeDir();
        if (home == null) {
            return null;
        }
        return platform == NodePlatform.WIN_X64 ? home.resolve("node.exe") : home.resolve("bin").resolve("node");
    }

    /** Managed node executable, but only when it actually exists on disk; null otherwise. */
    public Path getNodeExecutableIfAvailable() {
        Path exe = getNodeExecutablePath();
        return exe != null && Files.isRegularFile(exe) ? exe : null;
    }

    /** True when a previously downloaded managed runtime is present. */
    public boolean isManagedRuntimeAvailable() {
        return getNodeExecutableIfAvailable() != null;
    }

    /**
     * Ensures the managed runtime exists, downloading and extracting it when missing.
     *
     * <p>Idempotent and thread-safe: an already-installed runtime short-circuits to a
     * completed future; concurrent calls share one in-flight install. The returned future
     * completes with the node executable path on success, or exceptionally (with
     * {@link java.util.concurrent.CompletionException} wrapping an {@link UncheckedIOException})
     * when the platform is unsupported or the download/extraction/verification failed —
     * in which case all partial files are removed and any older runtime is left untouched.</p>
     *
     * <p>Intended to be called from plugin startup (Phase 1B) on a background thread;
     * never blocks the EDT itself.</p>
     */
    public CompletableFuture<Path> ensureRuntime() {
        Path available = getNodeExecutableIfAvailable();
        if (available != null) {
            return CompletableFuture.completedFuture(available);
        }
        synchronized (installLock) {
            if (inFlightInstall != null) {
                return inFlightInstall;
            }
            CompletableFuture<Path> future = CompletableFuture.supplyAsync(this::downloadAndInstall);
            future.whenComplete((path, error) -> {
                synchronized (installLock) {
                    inFlightInstall = null;
                }
            });
            inFlightInstall = future;
            return future;
        }
    }

    // ============================================================================
    // Install pipeline (runs on a background thread)
    // ============================================================================

    private Path downloadAndInstall() {
        try {
            if (platform == null) {
                throw new IOException("当前平台无官方预编译 Node 包，无法自动下载运行时: "
                        + System.getProperty("os.name", "") + "/" + System.getProperty("os.arch", ""));
            }
            // Re-check inside the task: the runtime may have appeared since ensureRuntime() was called
            Path existing = getNodeExecutableIfAvailable();
            if (existing != null) {
                return existing;
            }

            Files.createDirectories(baseDir);
            String dirName = runtimeDirName(platform);
            Path finalHome = baseDir.resolve(dirName);
            Path finalExe = getNodeExecutablePath();

            if (Files.isDirectory(finalHome) && !Files.isRegularFile(finalExe)) {
                // Half-installed leftover from a crashed run — remove it before reinstalling
                LOG.warn("[NodeRuntime] 清理残缺的运行时目录: " + finalHome);
                deleteRecursively(finalHome);
            }

            Path tempArchive = baseDir.resolve(archiveFileName(platform) + ".part-" + UUID.randomUUID());
            Path tempExtractDir = baseDir.resolve(dirName + ".tmp-" + UUID.randomUUID());
            try {
                String url = downloadUrl(resolveDistBaseUrl(), platform);
                LOG.info("[NodeRuntime] 开始下载 Node.js 运行时: " + url);
                download(url, tempArchive);

                extract(tempArchive, tempExtractDir);

                Path extractedHome = tempExtractDir.resolve(dirName);
                if (!Files.isDirectory(extractedHome)) {
                    throw new IOException("压缩包结构不符合预期，缺少顶层目录: " + dirName);
                }
                ensureExecutableBit(extractedHome);

                try {
                    Files.move(extractedHome, finalHome, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException e) {
                    Files.move(extractedHome, finalHome);
                }
            } finally {
                // Partial-download / partial-extraction cleanup: only the atomically moved
                // final directory is allowed to survive a failure.
                Files.deleteIfExists(tempArchive);
                if (Files.exists(tempExtractDir)) {
                    deleteRecursively(tempExtractDir);
                }
            }

            Path installed = getNodeExecutableIfAvailable();
            if (installed == null) {
                throw new IOException("安装后未找到 Node 可执行文件: " + finalExe);
            }
            if (!verifyNodeExecutable(installed)) {
                // Broken download (e.g. blocked by antivirus): drop it so the next attempt re-downloads
                deleteRecursively(finalHome);
                throw new IOException("下载的 Node 运行时无法执行（--version 校验失败）: " + installed);
            }
            LOG.info("[NodeRuntime] Node.js 运行时就绪: " + installed);
            return installed;
        } catch (IOException e) {
            LOG.warn("[NodeRuntime] 自动准备 Node.js 运行时失败: " + e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    /**
     * Downloads {@code url} to {@code destination}. Package-private so tests can stub it
     * out — unit tests must never hit the network.
     */
    void download(String url, Path destination) throws IOException {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(CONNECT_TIMEOUT_SECONDS))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
        HttpRequest request = HttpRequest.newBuilder(URI.create(url)).GET().build();
        HttpResponse<Path> response;
        try {
            response = client.send(request, HttpResponse.BodyHandlers.ofFile(destination));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("下载被中断: " + url, e);
        }
        if (response.statusCode() != 200) {
            Files.deleteIfExists(destination);
            throw new IOException("下载失败，HTTP " + response.statusCode() + ": " + url);
        }
    }

    /** Dispatches to the extractor matching this platform's archive format. */
    private void extract(Path archive, Path targetDir) throws IOException {
        if ("zip".equals(platform.archiveExtension)) {
            NodeArchiveExtractor.extractZip(archive, targetDir);
        } else {
            NodeArchiveExtractor.extractTarGz(archive, targetDir);
        }
    }

    /**
     * Runs {@code node --version} to prove the downloaded binary actually works on this
     * machine. Package-private so tests can stub it (fake fixtures are not real binaries).
     */
    boolean verifyNodeExecutable(Path nodeExecutable) {
        try {
            Process process = new ProcessBuilder(nodeExecutable.toString(), "--version").start();
            String version = null;
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                version = reader.readLine();
            }
            boolean finished = process.waitFor(VERIFY_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return false;
            }
            return process.exitValue() == 0 && version != null && version.trim().startsWith("v");
        } catch (Exception e) {
            LOG.debug("[NodeRuntime] 校验 Node 可执行文件失败 [" + nodeExecutable + "]: " + e.getMessage());
            return false;
        }
    }

    /** Makes sure everything under {@code <home>/bin} is executable on Unix filesystems. */
    private void ensureExecutableBit(Path runtimeHome) {
        if (platform == NodePlatform.WIN_X64) {
            return;
        }
        Path binDir = runtimeHome.resolve("bin");
        if (!Files.isDirectory(binDir)) {
            return;
        }
        try (var files = Files.list(binDir)) {
            files.filter(Files::isRegularFile).forEach(file -> {
                if (!file.toFile().setExecutable(true, false)) {
                    LOG.debug("[NodeRuntime] Could not set executable bit: " + file);
                }
            });
        } catch (IOException e) {
            LOG.warn("[NodeRuntime] 设置可执行权限失败: " + e.getMessage());
        }
    }

    private static void deleteRecursively(Path dir) {
        if (!PlatformUtils.deleteDirectoryWithRetry(dir.toFile(), 3)) {
            LOG.warn("[NodeRuntime] 无法删除目录: " + dir);
        }
    }
}
