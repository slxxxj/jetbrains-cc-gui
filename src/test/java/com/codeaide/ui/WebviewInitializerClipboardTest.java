package com.codeaide.ui;

import org.junit.Test;

import static org.junit.Assert.assertNotNull;

/**
 * Tests for the clipboard file-path reader backing the webview paste flow.
 *
 * <p>The reader performs blocking AWT clipboard access and is dispatched
 * asynchronously by the getClipboardPathQuery handler (the CEF callback thread
 * must never touch the Windows OLE clipboard lock).  Its contract is defensive:
 * it must NEVER throw — headless test runners, an empty clipboard, or an OLE
 * access failure all degrade to "".
 */
public class WebviewInitializerClipboardTest {

    @Test
    public void readClipboardFilePathNeverThrowsAndReturnsNonNull() {
        // On a headless runner Toolkit.getSystemClipboard() throws
        // HeadlessException, which the reader must swallow into "".
        // On a windowed runner the clipboard simply holds no files (or some),
        // which maps to "" or a path — either way a non-null String.
        String path = WebviewInitializer.readClipboardFilePath();
        assertNotNull("reader degrades to empty string instead of throwing", path);
    }
}
