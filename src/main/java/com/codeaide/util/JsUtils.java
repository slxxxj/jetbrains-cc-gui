package com.codeaide.util;

import com.google.gson.Gson;

import java.util.regex.Pattern;

/**
 * JavaScript utility class.
 * Provides helper methods for JavaScript string escaping and function invocation.
 */
public class JsUtils {

    private static final Pattern SAFE_JS_NAME = Pattern.compile("^[a-zA-Z_$][a-zA-Z0-9_$.]*$");
    private static final Gson GSON = new Gson();

    /**
     * Escape a string for safe embedding inside a JavaScript string literal.
     * Returns the escaped content WITHOUT surrounding quotes; callers add the quotes.
     * Delegates to Gson's JSON string encoding (handles quotes, control characters
     * and unicode, and encodes HTML-significant characters such as &lt; and ' as
     * unicode escapes, which also neutralizes &lt;/script&gt; breakout), then applies
     * explicit guards for JS line/paragraph separators and "&lt;/" as defense-in-depth.
     */
    public static String escapeJs(String str) {
        if (str == null) {
            return "";
        }
        String json = GSON.toJson(str);
        // Strip the surrounding double quotes added by Gson; callers wrap the
        // result in their own quotes (single quotes by convention).
        return json.substring(1, json.length() - 1)
            .replace("\u2028", "\\u2028")  // Line separator
            .replace("\u2029", "\\u2029")  // Paragraph separator
            .replace("</", "<\\/");        // Prevent </script> breakout in HTML context
    }

    /**
     * Build a JavaScript function call guarded by an existence check and try/catch.
     * A simple name (no dot) is invoked as window.&lt;name&gt;.
     * @param functionName the function name (e.g. "onUsageUpdate" or "window.onUsageUpdate")
     * @param args pre-escaped string arguments (see {@link #escapeJs})
     * @return the JavaScript code
     */
    public static String buildJsCall(String functionName, String... args) {
        if (functionName == null || !SAFE_JS_NAME.matcher(functionName).matches()) {
            throw new IllegalArgumentException("Invalid JavaScript function name: " + functionName);
        }
        String callee = functionName.contains(".") ? functionName : "window." + functionName;

        StringBuilder argsJs = new StringBuilder();
        if (args != null) {
            for (int i = 0; i < args.length; i++) {
                if (i > 0) { argsJs.append(", "); }
                argsJs.append("'").append(args[i] == null ? "" : args[i]).append("'");
            }
        }

        return "(function() {" +
                "  try {" +
                "    if (typeof " + callee + " === 'function') {" +
                "      " + callee + "(" + argsJs + ");" +
                "    }" +
                "  } catch (e) {" +
                "    console.error('[Backend->Frontend] Failed to call " + functionName + ":', e);" +
                "  }" +
                "})();";
    }
}
