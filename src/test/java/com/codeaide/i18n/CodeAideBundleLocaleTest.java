package com.codeaide.i18n;

import org.junit.Test;

import java.util.Locale;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Verifies explicit-locale bundle resolution used by the commit message feature
 * when the user's configured language differs from the IDE locale.
 */
public class CodeAideBundleLocaleTest {

    @Test
    public void shouldResolveSimplifiedChinese() {
        String text = CodeAideBundle.messageForLocale("commit.generating", Locale.SIMPLIFIED_CHINESE);

        assertTrue(text.contains("正在生成"));
    }

    @Test
    public void shouldResolveTraditionalChinese() {
        String text = CodeAideBundle.messageForLocale("commit.generating", Locale.TRADITIONAL_CHINESE);

        assertTrue(text.contains("正在產生"));
    }

    @Test
    public void shouldResolveEnglish() {
        String text = CodeAideBundle.messageForLocale("commit.generating", Locale.ENGLISH);

        assertEquals("Generating commit message...", text);
    }

    @Test
    public void shouldFallBackToBaseBundleForUnsupportedLocale() {
        // No Korean bundle exists; the lookup must resolve to the base bundle
        // and never cross into the JVM default locale.
        String text = CodeAideBundle.messageForLocale("commit.generating", Locale.KOREAN);

        assertEquals("Generating commit message...", text);
    }
}
