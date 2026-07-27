package com.codeaide.runtime;

import com.codeaide.runtime.NodeRuntimeManager.NodePlatform;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.GZIPOutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Unit tests for {@link NodeRuntimeManager} and {@link NodeArchiveExtractor}.
 * Covers pure logic (platform detection, URL building, directory conventions) and
 * install-pipeline semantics (reuse, failure cleanup, concurrency) with stubbed
 * downloads — no test ever touches the network.
 */
public class NodeRuntimeManagerTest {

    @Rule
    public final TemporaryFolder tmp = new TemporaryFolder();

    // ============================================================================
    // Platform detection
    // ============================================================================

    @Test
    public void detectPlatform_windowsAmd64() {
        assertEquals(NodePlatform.WIN_X64, NodeRuntimeManager.detectPlatform("Windows 11", "amd64"));
        assertEquals(NodePlatform.WIN_X64, NodeRuntimeManager.detectPlatform("windows 10", "x86_64"));
    }

    @Test
    public void detectPlatform_mac() {
        assertEquals(NodePlatform.MAC_ARM64, NodeRuntimeManager.detectPlatform("Mac OS X", "aarch64"));
        assertEquals(NodePlatform.MAC_X64, NodeRuntimeManager.detectPlatform("Mac OS X", "x86_64"));
    }

    @Test
    public void detectPlatform_linux() {
        assertEquals(NodePlatform.LINUX_X64, NodeRuntimeManager.detectPlatform("Linux", "amd64"));
    }

    @Test
    public void detectPlatform_unsupported_returnsNull() {
        assertNull(NodeRuntimeManager.detectPlatform("Windows 11", "aarch64"));
        assertNull(NodeRuntimeManager.detectPlatform("Linux", "aarch64"));
        assertNull(NodeRuntimeManager.detectPlatform("SunOS", "amd64"));
        assertNull(NodeRuntimeManager.detectPlatform(null, null));
    }

    // ============================================================================
    // Naming & URL conventions
    // ============================================================================

    @Test
    public void runtimeDirName_matchesNodeDistConvention() {
        String expected = "node-v" + NodeRuntimeManager.NODE_VERSION + "-";
        assertEquals(expected + "win-x64", NodeRuntimeManager.runtimeDirName(NodePlatform.WIN_X64));
        assertEquals(expected + "darwin-arm64", NodeRuntimeManager.runtimeDirName(NodePlatform.MAC_ARM64));
        assertEquals(expected + "darwin-x64", NodeRuntimeManager.runtimeDirName(NodePlatform.MAC_X64));
        assertEquals(expected + "linux-x64", NodeRuntimeManager.runtimeDirName(NodePlatform.LINUX_X64));
    }

    @Test
    public void archiveFileName_usesZipForWindowsAndTarGzForUnix() {
        assertTrue(NodeRuntimeManager.archiveFileName(NodePlatform.WIN_X64).endsWith(".zip"));
        assertTrue(NodeRuntimeManager.archiveFileName(NodePlatform.MAC_X64).endsWith(".tar.gz"));
        assertTrue(NodeRuntimeManager.archiveFileName(NodePlatform.MAC_ARM64).endsWith(".tar.gz"));
        assertTrue(NodeRuntimeManager.archiveFileName(NodePlatform.LINUX_X64).endsWith(".tar.gz"));
    }

    @Test
    public void downloadUrl_followsOfficialDistLayout() {
        String url = NodeRuntimeManager.downloadUrl(NodeRuntimeManager.DEFAULT_DIST_BASE_URL, NodePlatform.WIN_X64);
        assertEquals("https://nodejs.org/dist/v" + NodeRuntimeManager.NODE_VERSION
                + "/node-v" + NodeRuntimeManager.NODE_VERSION + "-win-x64.zip", url);
    }

    @Test
    public void downloadUrl_npmmirrorUsesSameLayout() {
        String url = NodeRuntimeManager.downloadUrl(NodeRuntimeManager.NPMMIRROR_DIST_BASE_URL, NodePlatform.MAC_ARM64);
        assertEquals("https://registry.npmmirror.com/-/binary/node/v" + NodeRuntimeManager.NODE_VERSION
                + "/node-v" + NodeRuntimeManager.NODE_VERSION + "-darwin-arm64.tar.gz", url);
    }

    @Test
    public void downloadUrl_normalizesMissingTrailingSlash() {
        String url = NodeRuntimeManager.downloadUrl("https://nodejs.org/dist", NodePlatform.LINUX_X64);
        assertTrue(url.startsWith("https://nodejs.org/dist/v"));
    }

    @Test
    public void resolveDistBaseUrl_defaultOverrideAndShorthand() {
        String key = NodeRuntimeManager.DIST_BASE_URL_PROPERTY;
        String previous = System.getProperty(key);
        try {
            System.clearProperty(key);
            assertEquals(NodeRuntimeManager.DEFAULT_DIST_BASE_URL, NodeRuntimeManager.resolveDistBaseUrl());

            System.setProperty(key, "npmmirror");
            assertEquals(NodeRuntimeManager.NPMMIRROR_DIST_BASE_URL, NodeRuntimeManager.resolveDistBaseUrl());

            System.setProperty(key, "https://node.example.internal/dist/");
            assertEquals("https://node.example.internal/dist/", NodeRuntimeManager.resolveDistBaseUrl());
        } finally {
            if (previous == null) {
                System.clearProperty(key);
            } else {
                System.setProperty(key, previous);
            }
        }
    }

    // ============================================================================
    // Directory conventions
    // ============================================================================

    @Test
    public void nodeExecutablePath_windowsLayout() {
        NodeRuntimeManager manager = newManager(NodePlatform.WIN_X64);
        Path expected = manager.getBaseDir()
                .resolve(NodeRuntimeManager.runtimeDirName(NodePlatform.WIN_X64))
                .resolve("node.exe");
        assertEquals(expected, manager.getNodeExecutablePath());
    }

    @Test
    public void nodeExecutablePath_unixLayout() {
        NodeRuntimeManager manager = newManager(NodePlatform.LINUX_X64);
        Path expected = manager.getBaseDir()
                .resolve(NodeRuntimeManager.runtimeDirName(NodePlatform.LINUX_X64))
                .resolve("bin").resolve("node");
        assertEquals(expected, manager.getNodeExecutablePath());
    }

    @Test
    public void unsupportedPlatform_pathsAreNull() {
        NodeRuntimeManager manager = newManager(null);
        assertNull(manager.getRuntimeHomeDir());
        assertNull(manager.getNodeExecutablePath());
        assertNull(manager.getNodeExecutableIfAvailable());
        assertFalse(manager.isManagedRuntimeAvailable());
    }

    @Test
    public void isManagedRuntimeAvailable_tracksExecutablePresence() throws IOException {
        NodeRuntimeManager manager = newManager(NodePlatform.WIN_X64);
        assertFalse(manager.isManagedRuntimeAvailable());

        Path exe = manager.getNodeExecutablePath();
        Files.createDirectories(exe.getParent());
        Files.write(exe, new byte[]{0});
        assertTrue(manager.isManagedRuntimeAvailable());
        assertEquals(exe, manager.getNodeExecutableIfAvailable());
    }

    // ============================================================================
    // ensureRuntime: reuse, install, cleanup, concurrency
    // ============================================================================

    @Test
    public void ensureRuntime_existingRuntimeIsReusedWithoutDownload() throws Exception {
        NodeRuntimeManager manager = newManager(NodePlatform.WIN_X64);
        Path exe = manager.getNodeExecutablePath();
        Files.createDirectories(exe.getParent());
        Files.write(exe, new byte[]{0});

        StubbedManager stub = new StubbedManager(manager.getBaseDir(), NodePlatform.WIN_X64);
        // Even the stubbed manager sees the pre-existing executable and must not download
        Path result = stub.ensureRuntime().get(10, TimeUnit.SECONDS);
        assertEquals(exe, result);
        assertEquals(0, stub.downloadCount.get());
    }

    @Test
    public void ensureRuntime_installsFromStubbedZipAndIsIdempotent() throws Exception {
        StubbedManager stub = new StubbedManager(tmp.newFolder().toPath(), NodePlatform.WIN_X64);
        String dirName = NodeRuntimeManager.runtimeDirName(NodePlatform.WIN_X64);
        stub.downloadBehavior = (url, dest) -> writeZip(dest, dirName + "/node.exe");

        Path first = stub.ensureRuntime().get(10, TimeUnit.SECONDS);
        assertEquals(stub.getNodeExecutablePath(), first);
        assertTrue(Files.isRegularFile(first));
        assertEquals(1, stub.downloadCount.get());

        // Second call must short-circuit without downloading again
        Path second = stub.ensureRuntime().get(10, TimeUnit.SECONDS);
        assertEquals(first, second);
        assertEquals(1, stub.downloadCount.get());
    }

    @Test
    public void ensureRuntime_concurrentCallsShareSingleDownload() throws Exception {
        StubbedManager stub = new StubbedManager(tmp.newFolder().toPath(), NodePlatform.WIN_X64);
        String dirName = NodeRuntimeManager.runtimeDirName(NodePlatform.WIN_X64);
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        stub.downloadBehavior = (url, dest) -> {
            entered.countDown();
            assertTrue(release.await(10, TimeUnit.SECONDS));
            writeZip(dest, dirName + "/node.exe");
        };

        CompletableFuture<Path> futureA = stub.ensureRuntime();
        assertTrue(entered.await(10, TimeUnit.SECONDS));
        CompletableFuture<Path> futureB = stub.ensureRuntime();
        release.countDown();

        assertEquals(futureA.get(10, TimeUnit.SECONDS), futureB.get(10, TimeUnit.SECONDS));
        assertEquals(1, stub.downloadCount.get());
    }

    @Test
    public void ensureRuntime_corruptArchiveCleansUpPartialFiles() throws Exception {
        StubbedManager stub = new StubbedManager(tmp.newFolder().toPath(), NodePlatform.LINUX_X64);
        stub.downloadBehavior = (url, dest) -> Files.write(dest, "not a tar.gz".getBytes(StandardCharsets.UTF_8));

        try {
            stub.ensureRuntime().join();
            fail("ensureRuntime should fail for a corrupt archive");
        } catch (CompletionException expected) {
            // expected
        }

        assertInstallAreaIsClean(stub);
        assertFalse(stub.isManagedRuntimeAvailable());
    }

    @Test
    public void ensureRuntime_corruptZipAlsoCleansUp() throws Exception {
        StubbedManager stub = new StubbedManager(tmp.newFolder().toPath(), NodePlatform.WIN_X64);
        stub.downloadBehavior = (url, dest) -> Files.write(dest, "not a zip".getBytes(StandardCharsets.UTF_8));

        try {
            stub.ensureRuntime().join();
            fail("ensureRuntime should fail for a corrupt archive");
        } catch (CompletionException expected) {
            // expected
        }

        assertInstallAreaIsClean(stub);
    }

    @Test
    public void ensureRuntime_halfInstalledLeftoverIsRemovedAndReinstalled() throws Exception {
        StubbedManager stub = new StubbedManager(tmp.newFolder().toPath(), NodePlatform.WIN_X64);
        // Simulate a crashed earlier install: runtime dir exists but has no node.exe
        Path leftover = stub.getRuntimeHomeDir().resolve("stale.txt");
        Files.createDirectories(leftover.getParent());
        Files.write(leftover, new byte[]{1});

        String dirName = NodeRuntimeManager.runtimeDirName(NodePlatform.WIN_X64);
        stub.downloadBehavior = (url, dest) -> writeZip(dest, dirName + "/node.exe");

        Path result = stub.ensureRuntime().get(10, TimeUnit.SECONDS);
        assertTrue(Files.isRegularFile(result));
        assertFalse("stale half-installed files must be gone", Files.exists(leftover));
    }

    @Test
    public void ensureRuntime_failedVerificationDropsBrokenRuntime() throws Exception {
        StubbedManager stub = new StubbedManager(tmp.newFolder().toPath(), NodePlatform.WIN_X64);
        String dirName = NodeRuntimeManager.runtimeDirName(NodePlatform.WIN_X64);
        stub.downloadBehavior = (url, dest) -> writeZip(dest, dirName + "/node.exe");
        stub.verifyResult = false; // binary does not run (e.g. blocked by antivirus)

        try {
            stub.ensureRuntime().join();
            fail("ensureRuntime should fail when the downloaded binary does not run");
        } catch (CompletionException expected) {
            // expected
        }

        assertInstallAreaIsClean(stub);
    }

    @Test
    public void ensureRuntime_unsupportedPlatformFailsWithoutSideEffects() throws Exception {
        StubbedManager stub = new StubbedManager(tmp.newFolder().toPath(), null);
        try {
            stub.ensureRuntime().join();
            fail("ensureRuntime should fail on unsupported platforms");
        } catch (CompletionException expected) {
            // expected
        }
        assertEquals(0, stub.downloadCount.get());
        assertInstallAreaIsClean(stub);
    }

    // ============================================================================
    // Archive extraction
    // ============================================================================

    @Test
    public void extractZip_rejectsZipSlipEntries() throws Exception {
        Path target = tmp.newFolder().toPath();
        Path evil = target.getParent().resolve("evil.txt");
        Path archive = tmp.newFile("evil.zip").toPath();
        try (ZipOutputStream zos = new ZipOutputStream(Files.newOutputStream(archive))) {
            zos.putNextEntry(new ZipEntry("../evil.txt"));
            zos.write(new byte[]{1});
            zos.closeEntry();
        }

        try {
            NodeArchiveExtractor.extractZip(archive, target);
            fail("ZipSlip entries must be rejected");
        } catch (IOException expected) {
            // expected
        }
        assertFalse(Files.exists(evil));
    }

    @Test
    public void extractTarGz_extractsFilesDirsAndExecBits() throws Exception {
        Path target = tmp.newFolder().toPath();
        String dirName = NodeRuntimeManager.runtimeDirName(NodePlatform.LINUX_X64);
        Path archive = tmp.newFile("node.tar.gz").toPath();

        List<TarEntry> entries = new ArrayList<>();
        entries.add(TarEntry.directory(dirName + "/"));
        entries.add(TarEntry.directory(dirName + "/bin/"));
        entries.add(TarEntry.file(dirName + "/bin/node", 0755, "fake-node"));
        entries.add(TarEntry.file(dirName + "/README.md", 0644, "readme"));
        writeTarGz(archive, entries);

        NodeArchiveExtractor.extractTarGz(archive, target);

        Path node = target.resolve(dirName).resolve("bin").resolve("node");
        assertTrue(Files.isRegularFile(node));
        assertEquals("fake-node", new String(Files.readAllBytes(node), StandardCharsets.UTF_8));
        assertEquals("readme", new String(Files.readAllBytes(
                target.resolve(dirName).resolve("README.md")), StandardCharsets.UTF_8));
        if (!System.getProperty("os.name", "").toLowerCase().contains("win")) {
            assertTrue("tar exec bit must be preserved", Files.isExecutable(node));
        }
    }

    // ============================================================================
    // Test fixtures
    // ============================================================================

    private NodeRuntimeManager newManager(NodePlatform platform) {
        return new NodeRuntimeManager(tmp.getRoot().toPath().resolve("node-runtime"), platform);
    }

    /** Asserts no partial download/extraction artifacts and no final runtime dir survive. */
    private void assertInstallAreaIsClean(NodeRuntimeManager manager) throws IOException {
        Path base = manager.getBaseDir();
        if (!Files.exists(base)) {
            return;
        }
        try (var stream = Files.list(base)) {
            List<Path> leftovers = new ArrayList<>();
            stream.forEach(leftovers::add);
            assertTrue("install area must be clean after failure, found: " + leftovers, leftovers.isEmpty());
        }
    }

    /** Manager with stubbed network + verification so tests never download real archives. */
    private static final class StubbedManager extends NodeRuntimeManager {
        private interface DownloadBehavior {
            void apply(String url, Path dest) throws Exception;
        }

        private final AtomicInteger downloadCount = new AtomicInteger();
        private volatile DownloadBehavior downloadBehavior = (url, dest) -> {
            throw new IOException("download not stubbed");
        };
        private volatile boolean verifyResult = true;

        StubbedManager(Path baseDir, NodePlatform platform) {
            super(baseDir, platform);
        }

        @Override
        void download(String url, Path destination) throws IOException {
            downloadCount.incrementAndGet();
            try {
                downloadBehavior.apply(url, destination);
            } catch (IOException e) {
                throw e;
            } catch (Exception e) {
                throw new IOException(e);
            }
        }

        @Override
        boolean verifyNodeExecutable(Path nodeExecutable) {
            return verifyResult;
        }
    }

    /** Writes a minimal zip containing a single file entry. */
    private static void writeZip(Path dest, String entryName) throws IOException {
        try (ZipOutputStream zos = new ZipOutputStream(Files.newOutputStream(dest))) {
            zos.putNextEntry(new ZipEntry(entryName));
            zos.write("fake-node".getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
        }
    }

    /** One entry of the minimal tar writer below. */
    private static final class TarEntry {
        private final String name;
        private final int mode;
        private final char type;
        private final byte[] content;

        private TarEntry(String name, int mode, char type, byte[] content) {
            this.name = name;
            this.mode = mode;
            this.type = type;
            this.content = content;
        }

        private static TarEntry file(String name, int mode, String content) {
            return new TarEntry(name, mode, '0', content.getBytes(StandardCharsets.UTF_8));
        }

        private static TarEntry directory(String name) {
            return new TarEntry(name, 0755, '5', new byte[0]);
        }
    }

    /** Writes a minimal ustar .tar.gz (short names only — enough for fixture layouts). */
    private static void writeTarGz(Path dest, List<TarEntry> entries) throws IOException {
        try (OutputStream fileOut = Files.newOutputStream(dest);
             GZIPOutputStream out = new GZIPOutputStream(fileOut)) {
            for (TarEntry entry : entries) {
                byte[] header = new byte[512];
                writeString(header, 0, 100, entry.name);
                writeOctal(header, 100, 8, entry.mode);
                writeOctal(header, 108, 8, 0); // uid
                writeOctal(header, 116, 8, 0); // gid
                writeOctal(header, 124, 12, entry.content.length);
                writeOctal(header, 136, 12, 0); // mtime
                header[156] = (byte) entry.type;
                writeString(header, 257, 6, "ustar");
                // checksum: field itself counts as spaces
                for (int i = 148; i < 156; i++) {
                    header[i] = ' ';
                }
                long checksum = 0;
                for (byte b : header) {
                    checksum += b & 0xFF;
                }
                writeOctal(header, 148, 7, checksum);
                header[155] = ' ';
                out.write(header);
                out.write(entry.content);
                int padding = (512 - entry.content.length % 512) % 512;
                out.write(new byte[padding]);
            }
            out.write(new byte[1024]); // two zero blocks mark end of archive
        }
    }

    private static void writeString(byte[] header, int offset, int length, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(bytes, 0, header, offset, Math.min(bytes.length, length));
    }

    private static void writeOctal(byte[] header, int offset, int length, long value) {
        String octal = Long.toOctalString(value);
        int start = offset + length - 1 - octal.length();
        for (int i = 0; i < octal.length(); i++) {
            header[start + i] = (byte) octal.charAt(i);
        }
    }
}
