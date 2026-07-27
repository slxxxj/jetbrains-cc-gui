package com.codeaide.util;

import org.junit.Test;

import java.util.Locale;

import static org.junit.Assert.assertEquals;

/**
 * Verifies the i18n-language-code to Locale / display-name mappings used by
 * the commit message feature to follow the configured UI language.
 */
public class LanguageConfigServiceLocaleTest {

    @Test
    public void shouldMapLanguageCodesToLocales() {
        assertEquals(Locale.SIMPLIFIED_CHINESE, LanguageConfigService.getLocaleForLanguage("zh"));
        assertEquals(Locale.TRADITIONAL_CHINESE, LanguageConfigService.getLocaleForLanguage("zh-TW"));
        assertEquals(Locale.ENGLISH, LanguageConfigService.getLocaleForLanguage("en"));
        assertEquals(Locale.FRENCH, LanguageConfigService.getLocaleForLanguage("fr"));
        assertEquals(Locale.JAPANESE, LanguageConfigService.getLocaleForLanguage("ja"));
        assertEquals(Locale.KOREAN, LanguageConfigService.getLocaleForLanguage("ko"));
        assertEquals(new Locale("pt", "BR"), LanguageConfigService.getLocaleForLanguage("pt-BR"));
    }

    @Test
    public void shouldDefaultToEnglishForUnknownOrNullCodes() {
        assertEquals(Locale.ENGLISH, LanguageConfigService.getLocaleForLanguage(null));
        assertEquals(Locale.ENGLISH, LanguageConfigService.getLocaleForLanguage("unknown"));
    }

    @Test
    public void shouldProvideDisplayNames() {
        assertEquals("Simplified Chinese (简体中文)", LanguageConfigService.getLanguageDisplayName("zh"));
        assertEquals("Traditional Chinese (繁體中文)", LanguageConfigService.getLanguageDisplayName("zh-TW"));
        assertEquals("Japanese (日本語)", LanguageConfigService.getLanguageDisplayName("ja"));
        assertEquals("English", LanguageConfigService.getLanguageDisplayName("en"));
    }

    @Test
    public void shouldDefaultDisplayNameToEnglishForUnknownOrNullCodes() {
        assertEquals("English", LanguageConfigService.getLanguageDisplayName(null));
        assertEquals("English", LanguageConfigService.getLanguageDisplayName("unknown"));
    }
}
