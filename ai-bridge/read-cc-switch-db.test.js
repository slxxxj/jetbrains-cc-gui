import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import initSqlJs from 'sql.js';

const SCRIPT_PATH = fileURLToPath(new URL('./read-cc-switch-db.js', import.meta.url));

const CLAUDE_ENV_SETTINGS = JSON.stringify({
    env: {
        ANTHROPIC_BASE_URL: 'https://claude.example.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-claude-env',
        ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    },
});

const CLAUDE_LEGACY_SETTINGS = JSON.stringify({
    base_url: 'https://legacy.example.com',
    api_key: 'sk-claude-legacy',
    model: 'claude-opus-4-1',
});

const CODEX_CONFIG_TOML = `disable_response_storage = true
model = "gpt-5.1-codex"
model_reasoning_effort = "high"
model_provider = "custom"

[model_providers.custom]
name = "Custom"
base_url = "https://codex.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
`;

const CODEX_SETTINGS = JSON.stringify({
    auth: { OPENAI_API_KEY: 'sk-codex-key' },
    config: CODEX_CONFIG_TOML,
});

const CODEX_SETTINGS_NO_AUTH = JSON.stringify({
    config: 'model = "gpt-5"\n',
});

/**
 * Build a throwaway cc-switch-like SQLite database with the given rows.
 * Returns the database file path (caller cleans up the temp directory).
 */
function createTestDb(rows) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-switch-test-'));
    const dbPath = path.join(dir, 'cc-switch.db');
    return initSqlJs().then(SQL => {
        const db = new SQL.Database();
        db.run(`CREATE TABLE providers (
            id TEXT PRIMARY KEY,
            name TEXT,
            app_type TEXT,
            settings_config TEXT,
            website_url TEXT,
            remark TEXT,
            created_at INTEGER,
            updated_at INTEGER
        )`);
        const stmt = db.prepare(
            'INSERT INTO providers (id, name, app_type, settings_config, website_url, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const row of rows) {
            stmt.run([
                row.id,
                row.name ?? null,
                row.app_type,
                row.settings_config ?? null,
                row.website_url ?? null,
                row.remark ?? null,
                row.created_at ?? null,
                row.updated_at ?? null,
            ]);
        }
        stmt.free();
        fs.writeFileSync(dbPath, Buffer.from(db.export()));
        db.close();
        return { dir, dbPath };
    });
}

/**
 * Run the reader script synchronously and return { exitCode, stdout, stderr }.
 */
function runReader(args) {
    try {
        const stdout = execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { exitCode: 0, stdout, stderr: '' };
    } catch (error) {
        return {
            exitCode: error.status ?? 1,
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? '',
        };
    }
}

function buildStandardRows() {
    return [
        {
            id: 'claude-env',
            name: 'Claude Env',
            app_type: 'claude',
            settings_config: CLAUDE_ENV_SETTINGS,
            website_url: 'https://claude.example.com',
            remark: 'claude remark',
            created_at: 1700000000,
            updated_at: 1700000001,
        },
        {
            id: 'claude-legacy',
            name: 'Claude Legacy',
            app_type: 'claude',
            settings_config: CLAUDE_LEGACY_SETTINGS,
        },
        {
            id: 'codex-main',
            name: 'Codex Main',
            app_type: 'codex',
            settings_config: CODEX_SETTINGS,
            website_url: 'https://codex.example.com',
            remark: 'codex remark',
            created_at: 1700000002,
            updated_at: 1700000003,
        },
        {
            id: 'codex-no-auth',
            name: null,
            app_type: 'codex',
            settings_config: CODEX_SETTINGS_NO_AUTH,
        },
    ];
}

test('default invocation keeps the legacy Claude-only output shape', async () => {
    const { dir, dbPath } = await createTestDb(buildStandardRows());
    try {
        const { exitCode, stdout } = runReader([dbPath]);
        assert.equal(exitCode, 0);

        const output = JSON.parse(stdout);
        assert.equal(output.success, true);
        assert.equal(output.count, 2);
        assert.equal(output.providers.length, 2);
        assert.ok(!('codex' in output), 'legacy output must not include a codex group');

        const envProvider = output.providers.find(p => p.id === 'claude-env');
        assert.equal(envProvider.name, 'Claude Env');
        assert.equal(envProvider.source, 'cc-switch');
        assert.equal(envProvider.settingsConfig.env.ANTHROPIC_BASE_URL, 'https://claude.example.com/anthropic');
        assert.equal(envProvider.settingsConfig.env.ANTHROPIC_AUTH_TOKEN, 'sk-claude-env');
        assert.equal(envProvider.baseUrl, 'https://claude.example.com/anthropic');
        assert.equal(envProvider.apiKey, 'sk-claude-env');
        assert.equal(envProvider.websiteUrl, 'https://claude.example.com');
        assert.equal(envProvider.remark, 'claude remark');
        assert.equal(envProvider.createdAt, 1700000000);
        assert.equal(envProvider.updatedAt, 1700000001);

        // Legacy base_url/api_key format is still normalized into env fields
        const legacyProvider = output.providers.find(p => p.id === 'claude-legacy');
        assert.equal(legacyProvider.settingsConfig.env.ANTHROPIC_BASE_URL, 'https://legacy.example.com');
        assert.equal(legacyProvider.settingsConfig.env.ANTHROPIC_AUTH_TOKEN, 'sk-claude-legacy');
        assert.equal(legacyProvider.baseUrl, 'https://legacy.example.com');
        assert.equal(legacyProvider.apiKey, 'sk-claude-legacy');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('explicit claude argument matches the default behavior', async () => {
    const { dir, dbPath } = await createTestDb(buildStandardRows());
    try {
        const { exitCode, stdout } = runReader([dbPath, 'claude']);
        assert.equal(exitCode, 0);
        const output = JSON.parse(stdout);
        assert.equal(output.success, true);
        assert.equal(output.count, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('codex argument returns mapped Codex providers with raw config/auth and preview fields', async () => {
    const { dir, dbPath } = await createTestDb(buildStandardRows());
    try {
        const { exitCode, stdout } = runReader([dbPath, 'codex']);
        assert.equal(exitCode, 0);

        const output = JSON.parse(stdout);
        assert.equal(output.success, true);
        assert.equal(output.count, 2);

        const main = output.providers.find(p => p.id === 'codex-main');
        assert.equal(main.name, 'Codex Main');
        assert.equal(main.source, 'cc-switch');
        // Raw cc-switch settings_config preserved
        assert.equal(main.settingsConfig.auth.OPENAI_API_KEY, 'sk-codex-key');
        assert.equal(main.settingsConfig.config, CODEX_CONFIG_TOML);
        // Raw config.toml / auth.json strings for the plugin mapping
        assert.equal(main.configToml, CODEX_CONFIG_TOML);
        assert.deepEqual(JSON.parse(main.authJson), { OPENAI_API_KEY: 'sk-codex-key' });
        // Preview helpers
        assert.equal(main.baseUrl, 'https://codex.example.com/v1');
        assert.equal(main.apiKey, 'sk-codex-key');
        assert.equal(main.model, 'gpt-5.1-codex');
        // Metadata
        assert.equal(main.websiteUrl, 'https://codex.example.com');
        assert.equal(main.remark, 'codex remark');
        assert.equal(main.createdAt, 1700000002);
        assert.equal(main.updatedAt, 1700000003);

        const noAuth = output.providers.find(p => p.id === 'codex-no-auth');
        assert.equal(noAuth.name, 'codex-no-auth', 'falls back to id when name is null');
        assert.equal(noAuth.model, 'gpt-5');
        assert.ok(!('apiKey' in noAuth), 'no apiKey preview without auth');
        assert.ok(!('authJson' in noAuth), 'no authJson without auth');
        assert.ok(!('baseUrl' in noAuth), 'no baseUrl without base_url in TOML');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('all argument returns both groups in a single run', async () => {
    const { dir, dbPath } = await createTestDb(buildStandardRows());
    try {
        const { exitCode, stdout } = runReader([dbPath, 'all']);
        assert.equal(exitCode, 0);

        const output = JSON.parse(stdout);
        assert.equal(output.success, true);
        assert.equal(output.claude.length, 2);
        assert.equal(output.codex.length, 2);
        assert.equal(output.claude[0].source, 'cc-switch');
        assert.equal(output.codex[0].source, 'cc-switch');
        assert.ok(!('providers' in output), 'all output uses named groups, not the legacy providers key');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('empty database yields a successful empty result', async () => {
    const { dir, dbPath } = await createTestDb([]);
    try {
        for (const args of [[dbPath], [dbPath, 'codex']]) {
            const { exitCode, stdout } = runReader(args);
            assert.equal(exitCode, 0);
            const output = JSON.parse(stdout);
            assert.deepEqual(output, { success: true, providers: [], count: 0 });
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('missing database file fails with a JSON error', () => {
    const { exitCode, stderr } = runReader([path.join(os.tmpdir(), 'definitely-not-here-cc-switch.db')]);
    assert.equal(exitCode, 1);
    const output = JSON.parse(stderr);
    assert.equal(output.success, false);
    assert.match(output.error, /does not exist/);
});

test('invalid appType argument fails with a JSON error', async () => {
    const { dir, dbPath } = await createTestDb([]);
    try {
        const { exitCode, stderr } = runReader([dbPath, 'gemini']);
        assert.equal(exitCode, 1);
        const output = JSON.parse(stderr);
        assert.equal(output.success, false);
        assert.match(output.error, /Invalid appType/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
