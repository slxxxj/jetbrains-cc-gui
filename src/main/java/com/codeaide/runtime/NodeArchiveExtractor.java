package com.codeaide.runtime;

import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.GZIPInputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Pure-Java archive extraction for the managed Node.js runtime.
 * Supports the two formats published on nodejs.org/dist: {@code .zip} (Windows)
 * and {@code .tar.gz} (macOS / Linux).
 *
 * <p>Written instead of shelling out to system {@code tar}/{@code unzip} so the
 * bootstrap path has no external command dependency (compare
 * {@code BridgeArchiveExtractor}, which prefers system tools for the ai-bridge zip).
 * All entries are validated against ZipSlip-style path traversal.</p>
 *
 * <p>Package-private helper of {@link NodeRuntimeManager}.</p>
 */
final class NodeArchiveExtractor {

    private static final Logger LOG = Logger.getInstance(NodeArchiveExtractor.class);

    private static final int TAR_BLOCK_SIZE = 512;
    private static final int EXECUTABLE_BIT_MASK = 0111;

    private NodeArchiveExtractor() {
    }

    /**
     * Extracts a .zip archive into {@code targetDir}.
     * Note: zip does not carry reliable Unix permission bits; callers that need
     * an executable bit on Unix should not be using the zip flavor (Windows only).
     */
    static void extractZip(Path archive, Path targetDir) throws IOException {
        Path target = targetDir.toAbsolutePath().normalize();
        Files.createDirectories(target);

        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(Files.newInputStream(archive)))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                Path resolved = resolveSafely(target, entry.getName());
                if (entry.isDirectory()) {
                    Files.createDirectories(resolved);
                } else {
                    if (resolved.getParent() != null) {
                        Files.createDirectories(resolved.getParent());
                    }
                    // ZipInputStream signals end-of-entry with -1, so a plain copy stops at the entry boundary.
                    Files.copy(zis, resolved, StandardCopyOption.REPLACE_EXISTING);
                }
                zis.closeEntry();
            }
        }
    }

    /**
     * Extracts a .tar.gz archive into {@code targetDir}.
     * Handles ustar prefixes, GNU long-name ('L') entries, and pax ('x') path overrides,
     * which covers the layout produced for official Node.js tarballs. Executable bits
     * from the tar mode field are applied to regular files. Symlinks (bin/npm, bin/npx)
     * are created best-effort and skipped with a warning when the FS refuses them.
     */
    static void extractTarGz(Path archive, Path targetDir) throws IOException {
        Path target = targetDir.toAbsolutePath().normalize();
        Files.createDirectories(target);
        Map<Path, String> symlinks = new LinkedHashMap<>();

        try (InputStream in = new BufferedInputStream(new GZIPInputStream(Files.newInputStream(archive)))) {
            byte[] header = new byte[TAR_BLOCK_SIZE];
            String longName = null;
            while (readFully(in, header)) {
                if (isAllZero(header)) {
                    break; // End-of-archive marker (two zero blocks; one is enough to stop)
                }

                String name = headerString(header, 0, 100);
                int mode = (int) headerNumber(header, 100, 8);
                long size = headerNumber(header, 124, 12);
                char type = (char) (header[156] & 0xFF);
                String prefix = headerString(header, 345, 155);

                if (type == 'L') {
                    // GNU long name: payload is the NUL-terminated name of the next entry
                    longName = stripTrailingNul(new String(readEntryData(in, size), StandardCharsets.UTF_8));
                    continue;
                }
                if (type == 'x') {
                    // pax extended header: look for a "path=" record
                    String paxPath = parsePaxPath(new String(readEntryData(in, size), StandardCharsets.UTF_8));
                    if (paxPath != null) {
                        longName = paxPath;
                    }
                    continue;
                }
                if (type == 'g') {
                    skipFully(in, paddedSize(size)); // Global pax header: not needed
                    continue;
                }

                String entryName = longName != null ? longName : (prefix.isEmpty() ? name : prefix + "/" + name);
                longName = null;
                Path resolved = resolveSafely(target, entryName);

                if (type == '5') {
                    Files.createDirectories(resolved);
                    skipFully(in, paddedSize(size));
                } else if (type == '2') {
                    symlinks.put(resolved, headerString(header, 157, 100));
                    skipFully(in, paddedSize(size));
                } else if (type == '0' || type == '\0' || type == '7') {
                    if (resolved.getParent() != null) {
                        Files.createDirectories(resolved.getParent());
                    }
                    try (OutputStream out = Files.newOutputStream(resolved)) {
                        copyExactly(in, out, size);
                    }
                    skipFully(in, paddedSize(size) - size);
                    if ((mode & EXECUTABLE_BIT_MASK) != 0) {
                        if (!resolved.toFile().setExecutable(true, false)) {
                            LOG.debug("[NodeRuntime] Could not set executable bit: " + resolved);
                        }
                    }
                } else {
                    // Hard links, devices, fifos: not needed for a Node.js runtime
                    skipFully(in, paddedSize(size));
                }
            }
        }

        for (Map.Entry<Path, String> link : symlinks.entrySet()) {
            try {
                if (link.getKey().getParent() != null) {
                    Files.createDirectories(link.getKey().getParent());
                }
                Files.createSymbolicLink(link.getKey(), Paths.get(link.getValue()));
            } catch (Exception e) {
                LOG.warn("[NodeRuntime] Skipping symlink " + link.getKey() + " -> " + link.getValue() + ": " + e.getMessage());
            }
        }
    }

    /** Resolves an entry name under {@code target}, rejecting path traversal attempts. */
    private static Path resolveSafely(Path target, String entryName) throws IOException {
        Path normalized = target.resolve(entryName).normalize();
        if (!normalized.startsWith(target)) {
            throw new IOException("Unsafe archive entry detected: " + entryName);
        }
        return normalized;
    }

    /** Reads exactly {@code buf.length} bytes; returns false on clean EOF before the first byte. */
    private static boolean readFully(InputStream in, byte[] buf) throws IOException {
        int offset = 0;
        while (offset < buf.length) {
            int read = in.read(buf, offset, buf.length - offset);
            if (read < 0) {
                if (offset == 0) {
                    return false;
                }
                throw new IOException("Truncated tar archive");
            }
            offset += read;
        }
        return true;
    }

    /** Reads an entry payload of {@code size} bytes plus its 512-byte block padding. */
    private static byte[] readEntryData(InputStream in, long size) throws IOException {
        if (size > Integer.MAX_VALUE) {
            throw new IOException("Tar entry too large: " + size);
        }
        byte[] data = new byte[(int) size];
        int offset = 0;
        while (offset < data.length) {
            int read = in.read(data, offset, data.length - offset);
            if (read < 0) {
                throw new IOException("Truncated tar archive");
            }
            offset += read;
        }
        skipFully(in, paddedSize(size) - size);
        return data;
    }

    private static void copyExactly(InputStream in, OutputStream out, long size) throws IOException {
        byte[] buffer = new byte[8192];
        long remaining = size;
        while (remaining > 0) {
            int read = in.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (read < 0) {
                throw new IOException("Truncated tar archive");
            }
            out.write(buffer, 0, read);
            remaining -= read;
        }
    }

    private static void skipFully(InputStream in, long bytes) throws IOException {
        long remaining = bytes;
        while (remaining > 0) {
            long skipped = in.skip(remaining);
            if (skipped <= 0) {
                if (in.read() < 0) {
                    throw new IOException("Truncated tar archive");
                }
                skipped = 1;
            }
            remaining -= skipped;
        }
    }

    private static long paddedSize(long size) {
        return (size + TAR_BLOCK_SIZE - 1) / TAR_BLOCK_SIZE * TAR_BLOCK_SIZE;
    }

    private static boolean isAllZero(byte[] block) {
        for (byte b : block) {
            if (b != 0) {
                return false;
            }
        }
        return true;
    }

    /** Extracts a NUL/space-padded ASCII field from a tar header. */
    private static String headerString(byte[] header, int offset, int length) {
        int end = offset;
        int limit = offset + length;
        while (end < limit && header[end] != 0) {
            end++;
        }
        return new String(header, offset, end - offset, StandardCharsets.US_ASCII).trim();
    }

    /**
     * Parses an octal (or base-256, when the high bit of the first byte is set)
     * numeric field from a tar header.
     */
    private static long headerNumber(byte[] header, int offset, int length) {
        if ((header[offset] & 0x80) != 0) {
            // base-256 (binary) encoding: clear the marker bit, then big-endian
            long value = header[offset] & 0x7F;
            for (int i = offset + 1; i < offset + length; i++) {
                value = (value << 8) | (header[i] & 0xFF);
            }
            return value;
        }
        long value = 0;
        for (int i = offset; i < offset + length; i++) {
            byte b = header[i];
            if (b >= '0' && b <= '7') {
                value = (value << 3) | (b - '0');
            } else if (b != 0 && b != ' ') {
                break;
            }
        }
        return value;
    }

    /** Finds the "path=" record in a pax extended header payload; null when absent. */
    private static String parsePaxPath(String paxData) {
        // Records look like "27 path=some/name\n" (decimal length prefix, space, key=value, newline)
        for (String record : paxData.split("\n")) {
            int space = record.indexOf(' ');
            if (space < 0 || space + 1 >= record.length()) {
                continue;
            }
            String kv = record.substring(space + 1);
            if (kv.startsWith("path=")) {
                return kv.substring("path=".length());
            }
        }
        return null;
    }

    private static String stripTrailingNul(String value) {
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '\0') {
            end--;
        }
        return value.substring(0, end);
    }
}
