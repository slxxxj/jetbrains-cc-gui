package com.codeaide.handler.provider;

import com.codeaide.bridge.NodeDetector;
import com.codeaide.handler.core.HandlerContext;
import com.codeaide.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Handles provider import/export operations: preview, file selection, and saving imported results.
 * Supports both Claude and Codex cc-switch imports (one-way snapshots from cc-switch.db).
 */
public class ProviderImportExportSupport {

    private static final Logger LOG = Logger.getInstance(ProviderImportExportSupport.class);
    private static final Gson GSON = new Gson();

    /**
     * Which cc-switch app group an import operation targets.
     */
    private enum CcSwitchTarget {
        CLAUDE("window.import_preview_result", "provider.ccswitch.noData"),
        CODEX("window.codex_import_preview_result", "provider.ccswitch.noDataCodex");

        final String previewCallback;
        final String noDataMessageKey;

        CcSwitchTarget(String previewCallback, String noDataMessageKey) {
            this.previewCallback = previewCallback;
            this.noDataMessageKey = noDataMessageKey;
        }
    }

    private final HandlerContext context;
    private final ClaudeProviderOperations claudeOps;
    private final CodexProviderOperations codexOps;

    public ProviderImportExportSupport(HandlerContext context, ClaudeProviderOperations claudeOps,
                                       CodexProviderOperations codexOps) {
        this.context = context;
        this.claudeOps = claudeOps;
        this.codexOps = codexOps;
    }

    /**
     * Preview cc-switch import (Claude providers).
     */
    public void handlePreviewCcSwitchImport() {
        previewCcSwitchImport(CcSwitchTarget.CLAUDE);
    }

    /**
     * Preview cc-switch import (Codex providers).
     */
    public void handlePreviewCodexCcSwitchImport() {
        previewCcSwitchImport(CcSwitchTarget.CODEX);
    }

    /**
     * Open file chooser for cc-switch database file (Claude providers).
     */
    public void handleOpenFileChooserForCcSwitch() {
        openFileChooserForCcSwitch(CcSwitchTarget.CLAUDE);
    }

    /**
     * Open file chooser for cc-switch database file (Codex providers).
     */
    public void handleOpenFileChooserForCodexCcSwitch() {
        openFileChooserForCcSwitch(CcSwitchTarget.CODEX);
    }

    /**
     * Preview cc-switch import from the default database location (~/.cc-switch/cc-switch.db).
     */
    private void previewCcSwitchImport(CcSwitchTarget target) {
        ApplicationManager.getApplication().invokeLater(() -> {
            String userHome = NodeDetector.resolveHomeForFileOps();
            String osName = System.getProperty("os.name").toLowerCase();

            File ccSwitchDir = new File(userHome, ".cc-switch");
            File dbFile = new File(ccSwitchDir, "cc-switch.db");

            LOG.info("[ProviderHandler] OS: " + osName);
            LOG.info("[ProviderHandler] User home: " + userHome);
            LOG.info("[ProviderHandler] cc-switch dir: " + ccSwitchDir.getAbsolutePath());
            LOG.info("[ProviderHandler] Database file path: " + dbFile.getAbsolutePath());
            boolean dbExists = fileExists(dbFile);
            LOG.info("[ProviderHandler] Database file exists: " + dbExists);

            if (!dbExists) {
                String errorMsg = com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.notFound", dbFile.getAbsolutePath());
                LOG.warn("[ProviderHandler] " + errorMsg);
                sendErrorToFrontend(com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.notFoundTitle"), errorMsg);
                return;
            }

            CompletableFuture.runAsync(() -> readAndSendPreview(dbFile, target));
        });
    }

    /**
     * Open file chooser for a cc-switch database file, then preview the import.
     */
    private void openFileChooserForCcSwitch(CcSwitchTarget target) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                FileChooserDescriptor descriptor = new FileChooserDescriptor(
                        true,   // chooseFiles
                        false,  // chooseFolders
                        false,  // chooseJars
                        false,  // chooseJarsAsFiles
                        false,  // chooseJarContents
                        false   // chooseMultiple
                );

                descriptor.setTitle(com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.selectTitle"));
                descriptor.setDescription(com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.selectDesc"));
                descriptor.withFileFilter(file -> {
                    String name = file.getName().toLowerCase();
                    return name.endsWith(".db");
                });

                // Set default path to .cc-switch under user home directory
                String userHome = NodeDetector.resolveHomeForFileOps();
                File defaultDir = new File(userHome, ".cc-switch");
                VirtualFile defaultVirtualFile = null;
                if (defaultDir.exists()) {
                    defaultVirtualFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
                                                 .findFileByPath(defaultDir.getAbsolutePath().replace('\\', '/'));
                }

                LOG.info("[ProviderHandler] Opening file chooser, default dir: " +
                                 (defaultVirtualFile != null ? defaultVirtualFile.getPath() : "user home"));

                // Open file chooser
                VirtualFile[] selectedFiles = FileChooser.chooseFiles(
                        descriptor,
                        context.getProject(),
                        defaultVirtualFile
                );

                if (selectedFiles.length == 0) {
                    LOG.info("[ProviderHandler] User cancelled file selection");
                    sendInfoToFrontend(
                            com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.cancelledTitle"),
                            com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.cancelled"));
                    return;
                }

                VirtualFile selectedFile = selectedFiles[0];
                String dbPath = selectedFile.getPath();
                File dbFile = new File(dbPath);

                LOG.info("[ProviderHandler] User selected database file path: " + dbFile.getAbsolutePath());
                boolean selectedExists = fileExists(dbFile);
                LOG.info("[ProviderHandler] Database file exists: " + selectedExists);

                if (!selectedExists) {
                    String errorMsg = com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.notFound", dbFile.getAbsolutePath());
                    LOG.warn("[ProviderHandler] " + errorMsg);
                    sendErrorToFrontend(com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.notFoundTitle"), errorMsg);
                    return;
                }

                if (!dbFile.canRead()) {
                    String errorMsg = com.codeaide.i18n.CodeAideBundle.message("error.cannotReadFile") + "\n" +
                                              dbFile.getAbsolutePath() + "\n" +
                                              com.codeaide.i18n.CodeAideBundle.message("error.checkFilePermissions");
                    LOG.error("[ProviderHandler] " + errorMsg);
                    sendErrorToFrontend(com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.permissionErrorTitle"), errorMsg);
                    return;
                }

                // Read database asynchronously
                CompletableFuture.runAsync(() -> readAndSendPreview(dbFile, target));

            } catch (Exception e) {
                String errorDetails = com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.fileChooserFailed") + ": " + e.getMessage();
                LOG.error("[ProviderHandler] " + errorDetails, e);
                sendErrorToFrontend(com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.fileChooserFailedTitle"), errorDetails);
            }
        });
    }

    /**
     * Read the database for the given target and push the preview result to the frontend.
     */
    private void readAndSendPreview(File dbFile, CcSwitchTarget target) {
        try {
            LOG.info("[ProviderHandler] Starting to read database file (" + target + ")...");
            List<JsonObject> providers = parseProviders(dbFile.getPath(), target);

            if (providers.isEmpty()) {
                LOG.info("[ProviderHandler] No " + target + " provider configs found in database");
                sendInfoToFrontend(
                        com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.noDataTitle"),
                        com.codeaide.i18n.CodeAideBundle.message(target.noDataMessageKey));
                return;
            }

            JsonArray providersArray = new JsonArray();
            for (JsonObject p : providers) {
                providersArray.add(p);
            }

            JsonObject response = new JsonObject();
            response.add("providers", providersArray);

            String jsonStr = GSON.toJson(response);
            LOG.info("[ProviderHandler] Successfully read " + providers.size() + " " + target + " provider configs");
            context.callJavaScript(target.previewCallback, context.escapeJs(jsonStr));

        } catch (Exception e) {
            String errorDetails = com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.readFailed") + ": " + e.getMessage();
            LOG.error("[ProviderHandler] " + errorDetails, e);
            sendErrorToFrontend(com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.readFailedTitle"), errorDetails);
        }
    }

    private List<JsonObject> parseProviders(String dbPath, CcSwitchTarget target) throws IOException {
        return target == CcSwitchTarget.CODEX
                ? context.getSettingsService().parseCodexProvidersFromCcSwitchDb(dbPath)
                : context.getSettingsService().parseProvidersFromCcSwitchDb(dbPath);
    }

    /**
     * Save imported Claude providers.
     */
    public void handleSaveImportedProviders(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                List<JsonObject> providers = parseProvidersPayload(content);
                if (providers.isEmpty()) {
                    return;
                }

                int count = context.getSettingsService().saveProviders(providers);

                ApplicationManager.getApplication().invokeLater(() -> {
                    claudeOps.handleGetProviders(); // Refresh UI
                    sendInfoToFrontend(
                            com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.importSuccessTitle"),
                            com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.importSuccess", count));
                });

            } catch (Exception e) {
                LOG.error("Failed to save imported providers", e);
                sendErrorToFrontend(com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.saveFailedTitle"), e.getMessage());
            }
        });
    }

    /**
     * Save imported Codex providers.
     */
    public void handleSaveImportedCodexProviders(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                List<JsonObject> providers = parseProvidersPayload(content);
                if (providers.isEmpty()) {
                    return;
                }

                int count = context.getSettingsService().saveCodexProviders(providers);

                ApplicationManager.getApplication().invokeLater(() -> {
                    codexOps.handleGetCodexProviders(); // Refresh UI
                    sendInfoToFrontend(
                            com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.importSuccessTitle"),
                            com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.importSuccess", count));
                });

            } catch (Exception e) {
                LOG.error("Failed to save imported Codex providers", e);
                sendErrorToFrontend(com.codeaide.i18n.CodeAideBundle.message("provider.ccswitch.saveFailedTitle"), e.getMessage());
            }
        });
    }

    /**
     * Parse the {@code { providers: [...] }} payload sent by the import confirm dialog.
     */
    private List<JsonObject> parseProvidersPayload(String content) {
        List<JsonObject> providers = new ArrayList<>();
        JsonObject request = GSON.fromJson(content, JsonObject.class);
        JsonArray providersArray = request.getAsJsonArray("providers");

        if (providersArray == null || providersArray.isEmpty()) {
            return providers;
        }

        for (JsonElement e : providersArray) {
            if (e.isJsonObject()) {
                providers.add(e.getAsJsonObject());
            }
        }
        return providers;
    }

    /**
     * Returns true if {@code file} exists, falling back to a {@code wsl -e test -f} check on Windows
     * when Java's {@code File.exists()} returns false for a WSL UNC path (the UNC service can be slow
     * to respond, causing spurious false negatives).
     */
    private boolean fileExists(File file) {
        if (file.exists()) {
            return true;
        }
        if (PlatformUtils.isWindows()) {
            String wslPath = NodeDetector.convertToWslPath(file.getAbsolutePath());
            if (wslPath != null && !wslPath.isEmpty() && wslPath.charAt(0) == '/') {
                return NodeDetector.wslFileExists(wslPath);
            }
        }
        return false;
    }

    /**
     * Send info notification to the frontend.
     */
    public void sendInfoToFrontend(String title, String message) {
        // Use multi-parameter passing to avoid JSON nested parsing issues
        context.callJavaScript("backend_notification", "info", context.escapeJs(title), context.escapeJs(message));
    }

    /**
     * Send error notification to the frontend.
     */
    public void sendErrorToFrontend(String title, String message) {
        // Use multi-parameter passing to avoid JSON nested parsing issues
        context.callJavaScript("backend_notification", "error", context.escapeJs(title), context.escapeJs(message));
    }
}
