package com.codeaide.i18n;

import com.intellij.DynamicBundle;
import org.jetbrains.annotations.Nls;
import org.jetbrains.annotations.NonNls;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.PropertyKey;

import java.text.MessageFormat;
import java.util.Locale;
import java.util.ResourceBundle;

/**
 * Resource bundle for CodeAide plugin localization.
 * <p>
 * This class provides access to localized strings defined in
 * messages/CodeAideBundle*.properties files.
 * </p>
 */
public class CodeAideBundle extends DynamicBundle {
    @NonNls
    private static final String BUNDLE = "messages.CodeAideBundle";
    private static final CodeAideBundle INSTANCE = new CodeAideBundle();

    private CodeAideBundle() {
        super(BUNDLE);
    }

    /**
     * Get a localized message from the bundle.
     *
     * @param key    the resource key
     * @param params optional parameters for message formatting
     * @return the localized message
     */
    @NotNull
    public static @Nls String message(@NotNull @PropertyKey(resourceBundle = BUNDLE) String key,
                                      Object @NotNull ... params) {
        return INSTANCE.getMessage(key, params);
    }

    /**
     * Get a localized message for an explicit Locale, bypassing the IDE default
     * locale. Used when the user has manually configured a UI language that
     * differs from the IDE language.
     * <p>
     * Uses a no-fallback control: the lookup chain never crosses into the JVM
     * default locale, so unsupported locales resolve straight to the base bundle.
     * </p>
     *
     * @param key    the resource key
     * @param locale the explicit locale to resolve the message for
     * @param params optional parameters for message formatting
     * @return the localized message
     */
    @NotNull
    public static @Nls String messageForLocale(@NotNull @PropertyKey(resourceBundle = BUNDLE) String key,
                                               @NotNull Locale locale,
                                               Object @NotNull ... params) {
        ResourceBundle bundle = ResourceBundle.getBundle(
                BUNDLE,
                locale,
                CodeAideBundle.class.getClassLoader(),
                ResourceBundle.Control.getNoFallbackControl(ResourceBundle.Control.FORMAT_PROPERTIES));
        String pattern = bundle.getString(key);
        return params.length == 0 ? pattern : MessageFormat.format(pattern, params);
    }
}
