package com.codeaide.settings;

import com.codeaide.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;

public class CodeaideSettingsServicePermissionTimeoutTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void clampsPermissionDialogTimeoutToSupportedRange() {
        assertEquals(120, CodeaideSettingsService.clampPermissionDialogTimeoutSeconds(120));
        assertEquals(30, CodeaideSettingsService.clampPermissionDialogTimeoutSeconds(1));
        assertEquals(3600, CodeaideSettingsService.clampPermissionDialogTimeoutSeconds(99999));
    }

    @Test
    public void defaultsMissingOrInvalidPermissionDialogTimeout() throws Exception {
        Path tempHome = Files.createTempDirectory("permission-timeout-home");
        useTemporaryHomeDirectory(tempHome);

        CodeaideSettingsService service = new CodeaideSettingsService();
        assertEquals(300, service.getPermissionDialogTimeoutSeconds());

        Path configPath = tempHome.resolve(".codeaide").resolve("config.json");
        Files.writeString(configPath, "{\"permissionDialogTimeoutSeconds\":\"bad\"}", StandardCharsets.UTF_8);

        assertEquals(300, service.getPermissionDialogTimeoutSeconds());
    }

    @Test
    public void persistsClampedPermissionDialogTimeout() throws Exception {
        Path tempHome = Files.createTempDirectory("permission-timeout-persist-home");
        useTemporaryHomeDirectory(tempHome);

        CodeaideSettingsService service = new CodeaideSettingsService();
        service.setPermissionDialogTimeoutSeconds(1);
        assertEquals(30, service.getPermissionDialogTimeoutSeconds());

        JsonObject config = service.readConfig();
        assertEquals(30, config.get("permissionDialogTimeoutSeconds").getAsInt());
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
        Files.createDirectories(tempHome.resolve(".codeaide"));
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}
