package com.codeaide;

import org.junit.Test;

import static org.junit.Assert.assertTrue;

public class LegacyToolWindowCompatibilityTest {

    @Test
    public void legacyToolWindowClassRemainsAssignableToCurrentImplementation() {
        assertTrue(
            com.codeaide.ui.toolwindow.ClaudeSDKToolWindow.class
                .isAssignableFrom(ClaudeSDKToolWindow.class)
        );
    }
}
