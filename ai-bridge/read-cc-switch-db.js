#!/usr/bin/env node
/**
 * Read provider configurations from cc-switch SQLite database.
 * Uses sql.js (pure JavaScript implementation, cross-platform compatible)
 *
 * Usage: node read-cc-switch-db.js <database file path> [appType]
 *   appType: 'claude' (default) | 'codex' | 'all'
 * Output:
 *   - appType 'claude' | 'codex': { success, providers, count } (legacy shape)
 *   - appType 'all':             { success, claude: [...], codex: [...] }
 */

import initSqlJs from 'sql.js';
import fs from 'fs';

// Get command-line arguments
const dbPath = process.argv[2];
const appType = (process.argv[3] || 'claude').toLowerCase();

if (!dbPath) {
    console.error(JSON.stringify({
        success: false,
        error: 'Missing database file path argument'
    }));
    process.exit(1);
}

if (!['claude', 'codex', 'all'].includes(appType)) {
    console.error(JSON.stringify({
        success: false,
        error: `Invalid appType argument: ${appType} (expected 'claude', 'codex' or 'all')`
    }));
    process.exit(1);
}

// Check if the file exists
if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({
        success: false,
        error: `Database file does not exist: ${dbPath}`
    }));
    process.exit(1);
}

/**
 * Convert a query result set into row objects keyed by column name.
 */
function queryProviderRows(db, appTypeValue) {
    const result = db.exec(`
        SELECT * FROM providers
        WHERE app_type = '${appTypeValue}'
    `);

    if (!result || result.length === 0 || !result[0].values || result[0].values.length === 0) {
        return [];
    }

    const columns = result[0].columns;
    return result[0].values.map(rowArray => {
        const row = {};
        columns.forEach((col, index) => {
            row[col] = rowArray[index];
        });
        return row;
    });
}

/**
 * Extract a top-level-style string value from TOML text, e.g. base_url = "https://...".
 * Matches only keys at the start of a line so `model` does not match `model_provider`.
 */
function extractTomlString(tomlText, key) {
    if (typeof tomlText !== 'string') {
        return null;
    }
    const pattern = new RegExp('^\\s*' + key + '\\s*=\\s*["\']([^"\']+)["\']', 'm');
    const match = tomlText.match(pattern);
    return match ? match[1] : null;
}

/**
 * Parse a Claude (app_type='claude') provider row.
 * Two settings_config formats are supported:
 * 1. New format (env contains environment variables): { env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN } }
 * 2. Legacy format (contains config directly): { base_url, api_key, model, ... }
 */
function parseClaudeProviderRow(row) {
    // Parse the settings_config JSON
    const settingsConfig = row.settings_config ? JSON.parse(row.settings_config) : {};

    let baseUrl = null;
    let apiKey = null;

    if (settingsConfig.env) {
        // New format: extract from the env object
        const env = settingsConfig.env;
        if (env.ANTHROPIC_BASE_URL) {
            baseUrl = env.ANTHROPIC_BASE_URL;
        }
        if (env.ANTHROPIC_AUTH_TOKEN) {
            apiKey = env.ANTHROPIC_AUTH_TOKEN;
        }
        // Also check other common environment variable names
        if (!apiKey && env.ANTHROPIC_API_KEY) {
            apiKey = env.ANTHROPIC_API_KEY;
        }
    }

    // Legacy format: extract directly from settingsConfig
    if (!baseUrl && settingsConfig.base_url) {
        baseUrl = settingsConfig.base_url;
    }
    if (!apiKey && settingsConfig.api_key) {
        apiKey = settingsConfig.api_key;
    }

    // Build settingsConfig from the original cc-switch settings_config,
    // preserving all cc-switch fields (including model, alwaysThinkingEnabled, etc.)
    const mergedSettingsConfig = {
        ...settingsConfig,
        env: {
            ...(settingsConfig.env || {}),
        },
    };

    // Build the provider config object in the format expected by the plugin
    const provider = {
        id: row.id,
        name: row.name || row.id,
        source: 'cc-switch',
        settingsConfig: mergedSettingsConfig,
    };

    // Set the env fields
    if (baseUrl) {
        provider.settingsConfig.env.ANTHROPIC_BASE_URL = baseUrl;
    }
    if (apiKey) {
        provider.settingsConfig.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    }

    // Also keep top-level fields for frontend preview display
    if (baseUrl) {
        provider.baseUrl = baseUrl;
    }
    if (apiKey) {
        provider.apiKey = apiKey;
    }

    addCommonMetadata(provider, row);
    return provider;
}

/**
 * Parse a Codex (app_type='codex') provider row.
 * cc-switch stores Codex providers as:
 *   { auth: { OPENAI_API_KEY: "..." }, config: "<raw config.toml text>" }
 * The raw fields are preserved so the Java side can map them onto the plugin's
 * Codex provider structure (configToml / authJson raw strings).
 */
function parseCodexProviderRow(row) {
    // Parse the settings_config JSON
    const settingsConfig = row.settings_config ? JSON.parse(row.settings_config) : {};

    const auth = settingsConfig.auth;
    const configToml = typeof settingsConfig.config === 'string' ? settingsConfig.config : null;

    // Extract common fields for preview display
    let apiKey = null;
    if (auth && typeof auth === 'object' && typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) {
        apiKey = auth.OPENAI_API_KEY;
    }
    const baseUrl = configToml ? extractTomlString(configToml, 'base_url') : null;
    const model = configToml ? extractTomlString(configToml, 'model') : null;

    // Build the provider object, preserving the original cc-switch settings_config
    const provider = {
        id: row.id,
        name: row.name || row.id,
        source: 'cc-switch',
        settingsConfig,
    };

    // Raw Codex settings files (config.toml / auth.json) for the plugin mapping
    if (configToml) {
        provider.configToml = configToml;
    }
    if (auth !== undefined && auth !== null) {
        provider.authJson = typeof auth === 'string' ? auth : JSON.stringify(auth);
    }

    // Also keep top-level fields for frontend preview display
    if (baseUrl) {
        provider.baseUrl = baseUrl;
    }
    if (apiKey) {
        provider.apiKey = apiKey;
    }
    if (model) {
        provider.model = model;
    }

    addCommonMetadata(provider, row);
    return provider;
}

/**
 * Attach shared metadata fields (website, remark, timestamps) to the provider.
 */
function addCommonMetadata(provider, row) {
    if (row.website_url) {
        provider.websiteUrl = row.website_url;
    }
    if (row.remark) {
        provider.remark = row.remark;
    }
    if (row.created_at) {
        provider.createdAt = row.created_at;
    }
    if (row.updated_at) {
        provider.updatedAt = row.updated_at;
    }
}

/**
 * Read and parse all providers of one app type, skipping rows that fail to parse.
 */
function readProviders(db, appTypeValue) {
    const rowParser = appTypeValue === 'codex' ? parseCodexProviderRow : parseClaudeProviderRow;
    return queryProviderRows(db, appTypeValue)
        .map(row => {
            try {
                return rowParser(row);
            } catch (e) {
                console.error(`Failed to parse provider config:`, e.message);
                return null;
            }
        })
        .filter(p => p !== null);
}

try {
    // Initialize sql.js
    const SQL = await initSqlJs();

    // Read the database file
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    if (appType === 'all') {
        // Query both groups in one run
        const claudeProviders = readProviders(db, 'claude');
        const codexProviders = readProviders(db, 'codex');
        db.close();
        console.log(JSON.stringify({
            success: true,
            claude: claudeProviders,
            codex: codexProviders
        }));
        process.exit(0);
    }

    const providers = readProviders(db, appType);

    // Close the database
    db.close();

    // Output the result (legacy single-group shape)
    console.log(JSON.stringify({
        success: true,
        providers: providers,
        count: providers.length
    }));

} catch (error) {
    console.error(JSON.stringify({
        success: false,
        error: `Failed to read database: ${error.message}`,
        stack: error.stack
    }));
    process.exit(1);
}
