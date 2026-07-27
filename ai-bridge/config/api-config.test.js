import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildCliEnv,
  buildWebviewControlledSettingsOverride,
  isWebviewControlledEnvVar,
} from './api-config.js';

const API_CONFIG_MODULE = pathToFileURL(path.resolve('ai-bridge/config/api-config.js')).href;

function buildChildEnv(homeDir) {
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };

  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_URL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ]) {
    delete env[key];
  }

  return env;
}

function runSetupApiKey(homeDir) {
  const script = `
    import { setupApiKey } from ${JSON.stringify(API_CONFIG_MODULE)};
    try {
      const result = setupApiKey();
      console.log(JSON.stringify({ ok: true, result }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error.message }));
    }
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: buildChildEnv(homeDir),
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function runInjectStartupEnv(homeDir) {
  const script = `
    import { injectStartupEnvVars } from ${JSON.stringify(API_CONFIG_MODULE)};
    injectStartupEnvVars();
    console.log(JSON.stringify({
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      AWS_PROFILE: process.env.AWS_PROFILE ?? null,
      AWS_REGION: process.env.AWS_REGION ?? null,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: buildChildEnv(homeDir),
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function runResyncStartupEnv(homeDir) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { injectStartupEnvVars } from ${JSON.stringify(API_CONFIG_MODULE)};

    const home = process.env.HOME;
    const codeaideDir = path.join(home, '.codeaide');
    const configPath = path.join(codeaideDir, 'config.json');

    injectStartupEnvVars();

    fs.writeFileSync(configPath, JSON.stringify({
      claude: {
        current: 'provider-a',
        providers: {
          'provider-a': {
            name: 'Provider A',
            settingsConfig: {}
          }
        }
      }
    }), 'utf8');

    injectStartupEnvVars();

    console.log(JSON.stringify({
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      AWS_PROFILE: process.env.AWS_PROFILE ?? null,
      AWS_REGION: process.env.AWS_REGION ?? null,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: buildChildEnv(homeDir),
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function writeCodeaideClaudeConfig(homeDir, current, providers = {}) {
  const codeaideDir = path.join(homeDir, '.codeaide');
  fs.mkdirSync(codeaideDir, { recursive: true });
  fs.writeFileSync(
    path.join(codeaideDir, 'config.json'),
    JSON.stringify({
      claude: {
        current,
        providers,
      },
    }),
    'utf8'
  );
}

function writeClaudeSettingsEnv(homeDir, env) {
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ env }),
    'utf8'
  );
}

// Run buildCliEnv() in an isolated child process whose HOME points at tempHome,
// so the provider-management decision is driven solely by the temp settings.json
// — never by the developer's real ~/.claude/settings.json.
function runBuildCliEnv(tempHome) {
  const script = `
    import { buildCliEnv } from ${JSON.stringify(API_CONFIG_MODULE)};
    const env = buildCliEnv();
    console.log(JSON.stringify({
      ENTRYPOINT: env.CLAUDE_CODE_ENTRYPOINT,
      USER_TYPE: env.USER_TYPE,
      HOST_MANAGED: env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
      EFFORT: env.CLAUDE_CODE_EFFORT_LEVEL,
      MAX_THINKING: env.MAX_THINKING_TOKENS,
      DISABLE_1M: env.CLAUDE_CODE_DISABLE_1M_CONTEXT,
      SDK_VERSION: env.CLAUDE_AGENT_SDK_VERSION,
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: {
        ...buildChildEnv(tempHome),
        // Verify the "drop inherited copy" path: the daemon may itself carry
        // the flag from a parent host. buildCliEnv must clear it for cloud
        // providers even when it is already in process.env.
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
        CLAUDE_CODE_EFFORT_LEVEL: 'max',
        MAX_THINKING_TOKENS: '64000',
        CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
        CLAUDE_AGENT_SDK_VERSION: 'should-not-leak',
        ANTHROPIC_MODEL: 'current-webview-model',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'current-webview-model',
        HTTPS_PROXY: 'http://proxy.example.com:8080',
      },
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function runLoadSkillPlugins(homeDir) {
  const script = `
    import { loadCodeaideSkillPlugins } from ${JSON.stringify(API_CONFIG_MODULE)};
    console.log(JSON.stringify({ plugins: loadCodeaideSkillPlugins() }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: buildChildEnv(homeDir),
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

// Run loadClaudeSettings() in an isolated child process so the managed/local
// merge semantics are driven solely by the temp HOME's config.json + settings.json.
function runLoadClaudeSettings(homeDir) {
  const script = `
    import { loadClaudeSettings } from ${JSON.stringify(API_CONFIG_MODULE)};
    console.log(JSON.stringify({ settings: loadClaudeSettings() }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: buildChildEnv(homeDir),
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

test('isWebviewControlledEnvVar classifies model, context, and reasoning controls correctly', () => {
  assert.equal(isWebviewControlledEnvVar('ANTHROPIC_MODEL'), true);
  assert.equal(isWebviewControlledEnvVar('anthropic_model'), true); // case-insensitive
  assert.equal(isWebviewControlledEnvVar('CLAUDE_CODE_EFFORT_LEVEL'), true);
  assert.equal(isWebviewControlledEnvVar('MAX_THINKING_TOKENS'), true);
  assert.equal(isWebviewControlledEnvVar('CLAUDE_CODE_DISABLE_1M_CONTEXT'), true);
  assert.equal(isWebviewControlledEnvVar('HTTPS_PROXY'), false);
  assert.equal(isWebviewControlledEnvVar('ANTHROPIC_API_KEY'), false);
});

test('buildCliEnv strips stale CLI override env vars and sets host-managed for first-party auth', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  // Active managed provider so loadClaudeSettings() returns settings; no cloud
  // flag set → host-managed should be '1'.
  writeCodeaideClaudeConfig(tempHome, 'provider-a', {
    'provider-a': { name: 'Provider A', settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: 'sk-test' } } },
  });
  writeClaudeSettingsEnv(tempHome, { ANTHROPIC_AUTH_TOKEN: 'sk-test' });

  const env = runBuildCliEnv(tempHome);

  // Reasoning/context controls stripped from the child env
  assert.equal(env.EFFORT, undefined);
  assert.equal(env.MAX_THINKING, undefined);
  assert.equal(env.DISABLE_1M, undefined);
  assert.equal(env.SDK_VERSION, undefined);
  // Identity + host-managed flag set for first-party auth
  assert.equal(env.ENTRYPOINT, 'cli');
  assert.equal(env.USER_TYPE, 'external');
  assert.equal(env.HOST_MANAGED, '1');
});

test('buildWebviewControlledSettingsOverride neutralizes Claude CLI settings env precedence', () => {
  assert.deepEqual(buildWebviewControlledSettingsOverride('claude-sonnet-4-6[1m]'), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '',
    },
  });

  assert.deepEqual(buildWebviewControlledSettingsOverride('claude-sonnet-4-6'), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    },
  });

  assert.deepEqual(buildWebviewControlledSettingsOverride(), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
    },
  });
});

test('buildWebviewControlledSettingsOverride carries the webview subagent model selection', () => {
  // Selected model: passed through so settings.json copies cannot override it.
  assert.deepEqual(buildWebviewControlledSettingsOverride('claude-sonnet-4-6', 'claude-haiku-4-5'), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5',
    },
  });

  // No selection (empty string): neutralizes settings.json copies so the CLI
  // falls back to the main model / its own default.
  assert.deepEqual(buildWebviewControlledSettingsOverride('claude-sonnet-4-6', ''), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
      CLAUDE_CODE_SUBAGENT_MODEL: '',
    },
  });

  // Argument omitted entirely (prompt enhancer, rewind): settings.json copies
  // stay untouched on those paths.
  assert.deepEqual(buildWebviewControlledSettingsOverride('claude-sonnet-4-6'), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    },
  });
});

test('buildCliEnv leaves CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST unset for cloud providers', () => {
  // Bedrock/Vertex/Foundry: the user's settings.json owns the provider switch.
  // The host-managed flag would make Claude Code strip it → 403, so it must be
  // absent — even when process.env already carries an inherited copy.
  for (const flag of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
    writeCodeaideClaudeConfig(tempHome, 'provider-a', {
      'provider-a': { name: 'Provider A', settingsConfig: { env: { [flag]: '1' } } },
    });
    writeClaudeSettingsEnv(tempHome, { [flag]: '1' });

    const env = runBuildCliEnv(tempHome);

    assert.equal(env.HOST_MANAGED, undefined,
      `${flag} should suppress the host-managed flag (and clear any inherited copy)`);
    // Identity env must still be present regardless of provider mode.
    assert.equal(env.ENTRYPOINT, 'cli');
    assert.equal(env.USER_TYPE, 'external');
  }
});

test('buildCliEnv leaves CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST unset for CLI login', () => {
  // Regression guard for #1327: CLI login relies on the Claude CLI's own OAuth
  // credentials. The host-managed flag makes the CLI strip its native credential
  // lookup, so an authenticated user gets "Not logged in · Please run /login".
  // cli_login is signaled purely by ~/.codeaide/config.json (claude.current), so
  // no cloud-provider flag is present — the pre-fix code wrongly defaulted to
  // host-managed here. The flag must be absent, even when process.env carries an
  // inherited copy from a parent Claude Code host.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  writeCodeaideClaudeConfig(tempHome, '__cli_login__');
  writeClaudeSettingsEnv(tempHome, {});

  const env = runBuildCliEnv(tempHome);

  assert.equal(env.HOST_MANAGED, undefined,
    'CLI login must suppress the host-managed flag (and clear any inherited copy)');
  // Identity env must still be present regardless of provider mode.
  assert.equal(env.ENTRYPOINT, 'cli');
  assert.equal(env.USER_TYPE, 'external');
});

test('setupApiKey does not fall back to Claude CLI credentials on disk', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: {} }), 'utf8');
  fs.writeFileSync(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'should-not-be-used' } }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'API Key not configured');
});

test('setupApiKey resolves managed provider credentials from codeaide config.json', () => {
  // Phase 5c: managed provider credentials live in ~/.codeaide/config.json
  // (provider settingsConfig.env), NOT in ~/.claude/settings.json.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  writeCodeaideClaudeConfig(tempHome, 'provider-a', {
    'provider-a': {
      name: 'Provider A',
      settingsConfig: {
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-ant-codeaide-token',
          ANTHROPIC_BASE_URL: 'https://provider-a.example.com',
        },
      },
    }
  });
  // No ~/.claude/settings.json at all — must not be required.

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'auth_token');
  assert.equal(result.result.apiKey, 'sk-ant-codeaide-token');
  assert.equal(result.result.baseUrl, 'https://provider-a.example.com');
  assert.equal(result.result.apiKeySource, 'codeaide config.json (ANTHROPIC_AUTH_TOKEN)');
  assert.equal(result.result.baseUrlSource, 'codeaide config.json');
});

test('setupApiKey managed provider credentials win over settings.json', () => {
  // Priority: codeaide provider entry > ~/.claude/settings.json. The official
  // file may still hold stale credentials written by external tools (cc-switch,
  // the official CLI) — managed mode must ignore them entirely: the provider's
  // token applies, and the disk-only base URL is NOT inherited.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  writeCodeaideClaudeConfig(tempHome, 'provider-a', {
    'provider-a': {
      name: 'Provider A',
      settingsConfig: {
        env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-codeaide-token' },
      },
    }
  });
  writeClaudeSettingsEnv(tempHome, {
    ANTHROPIC_AUTH_TOKEN: 'sk-ant-stale-settings-token',
    ANTHROPIC_BASE_URL: 'https://stale.example.com',
  });

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.apiKey, 'sk-ant-codeaide-token');
  assert.equal(result.result.baseUrl, undefined,
    'disk-only ANTHROPIC_BASE_URL is not whitelisted and must be ignored in managed mode');
  assert.equal(result.result.apiKeySource, 'codeaide config.json (ANTHROPIC_AUTH_TOKEN)');
});

test('setupApiKey ignores settings.json credentials when the managed provider has none', () => {
  // Isolation hardening: managed mode no longer falls back to disk credentials.
  // A provider entry without credentials means "not configured", even if
  // settings.json (possibly rewritten by external tools) still holds some.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodeaideClaudeConfig(tempHome, 'provider-a', {
    'provider-a': {
      name: 'Provider A',
      settingsConfig: {}
    }
  });

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-token',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'API Key not configured');
});

test('setupApiKey still honors a disk apiKeyHelper in managed mode (whitelisted field)', () => {
  // apiKeyHelper is on the managed-mode disk-inheritance whitelist: enterprise
  // key acquisition keeps working without provider-held credentials.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodeaideClaudeConfig(tempHome, 'provider-a', {
    'provider-a': {
      name: 'Provider A',
      settingsConfig: {}
    }
  });

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ apiKeyHelper: '/usr/local/bin/get-claude-key' }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'api_key_helper');
  assert.equal(result.result.apiKeySource, 'settings.json (apiKeyHelper)');
});

test('setupApiKey honors a Bedrock switch from the managed provider settingsConfig', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  writeCodeaideClaudeConfig(tempHome, 'bedrock-provider', {
    'bedrock-provider': {
      name: 'Bedrock Provider',
      settingsConfig: {
        env: { CLAUDE_CODE_USE_BEDROCK: '1' },
      },
    }
  });

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'aws_bedrock');
  assert.equal(result.result.apiKeySource, 'codeaide config.json (AWS_BEDROCK)');
});

test('setupApiKey does not read settings.json credentials when Claude provider is inactive', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodeaideClaudeConfig(tempHome, '');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-should-not-be-used',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'API Key not configured');
});

test('setupApiKey enters CLI login when config.json sets claude.current=__cli_login__', () => {
  // CLI login mode is identified by ~/.codeaide/config.json — NOT by any flag in
  // ~/.claude/settings.json. The plugin must never mutate the user's settings.json.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodeaideClaudeConfig(tempHome, '__cli_login__');

  // settings.json has no CLI login flag — we are explicitly verifying it is not required
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: {} }), 'utf8');

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'cli_login');
  assert.equal(result.result.apiKey, null);
});

test('setupApiKey CLI login takes priority over existing API keys (no fallback)', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodeaideClaudeConfig(tempHome, '__cli_login__');

  // Real-world scenario: user previously configured an API key under "use local
  // settings.json" mode, then switched to CLI login. The key remains in settings.json
  // (the plugin no longer deletes it), but CLI login mode MUST win — no silent fallback.
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-should-be-ignored',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'cli_login');
  assert.equal(result.result.apiKey, null);
  assert.equal(result.result.apiKeySource, 'CLI login (SDK native auth)');
});

test('setupApiKey honors legacy CCGUI_CLI_LOGIN_AUTHORIZED flag for backwards compatibility', () => {
  // Earlier plugin versions wrote CCGUI_CLI_LOGIN_AUTHORIZED=1 into settings.json.
  // Users upgrading from those versions may still have the flag — keep honoring it
  // as a fallback so they keep working until the residue is cleaned up.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // config.json points at the legacy provider id, not __cli_login__
  writeCodeaideClaudeConfig(tempHome, '__cli_login__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        CCGUI_CLI_LOGIN_AUTHORIZED: '1',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'cli_login');
  assert.equal(result.result.apiKey, null);
});

test('loadCodeaideSkillPlugins returns enabled skills for a managed provider', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const codeaideDir = path.join(tempHome, '.codeaide');
  fs.mkdirSync(codeaideDir, { recursive: true });
  fs.writeFileSync(
    path.join(codeaideDir, 'config.json'),
    JSON.stringify({
      claude: {
        current: 'provider-a',
        providers: { 'provider-a': { name: 'Provider A', settingsConfig: {} } },
      },
      skills: {
        'skill-one': { id: 'skill-one', path: '/tmp/skills/one', enabled: true },
        'skill-two': { id: 'skill-two', path: '/tmp/skills/two', enabled: false },
        'skill-three': { id: 'skill-three', path: '/tmp/skills/three' },
      },
    }),
    'utf8'
  );

  const result = runLoadSkillPlugins(tempHome);
  assert.deepEqual(result.plugins, [
    { type: 'local', path: '/tmp/skills/one' },
    { type: 'local', path: '/tmp/skills/three' },
  ]);
});

test('loadCodeaideSkillPlugins returns null for local settings / CLI login modes', () => {
  for (const current of ['__local_settings_json__', '__cli_login__']) {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
    const codeaideDir = path.join(tempHome, '.codeaide');
    fs.mkdirSync(codeaideDir, { recursive: true });
    fs.writeFileSync(
      path.join(codeaideDir, 'config.json'),
      JSON.stringify({
        claude: { current, providers: {} },
        skills: { 'skill-one': { id: 'skill-one', path: '/tmp/skills/one' } },
      }),
      'utf8'
    );

    const result = runLoadSkillPlugins(tempHome);
    assert.equal(result.plugins, null, `${current} must keep settings.json plugin semantics`);
  }
});

test('injectStartupEnvVars ignores local proxy settings when Claude provider is inactive', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodeaideClaudeConfig(tempHome, '');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

test('injectStartupEnvVars ignores local proxy settings for managed providers', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodeaideClaudeConfig(tempHome, 'provider-a', {
    'provider-a': {
      name: 'Provider A',
      settingsConfig: {}
    }
  });

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

test('injectStartupEnvVars accepts proxy settings for the authorized local provider', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodeaideClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, 'http://proxy.example.com:8080');
  assert.equal(result.HTTPS_PROXY, 'https://proxy.example.com:8443');
});

test('injectStartupEnvVars clears previously injected proxy vars after switching away from local mode', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodeaideClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runResyncStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

test('injectStartupEnvVars injects AWS credential vars for the authorized local provider', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodeaideClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        AWS_PROFILE: 'bedrock-profile',
        AWS_REGION: 'us-west-2',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      },
    }),
    'utf8'
  );

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.AWS_PROFILE, 'bedrock-profile');
  assert.equal(result.AWS_REGION, 'us-west-2');
  assert.equal(result.AWS_SECRET_ACCESS_KEY, 'test-secret-key');
});

test('injectStartupEnvVars clears previously injected AWS credential vars after switching away from local mode', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodeaideClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        AWS_PROFILE: 'bedrock-profile',
        AWS_REGION: 'us-west-2',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      },
    }),
    'utf8'
  );

  const result = runResyncStartupEnv(tempHome);
  assert.equal(result.AWS_PROFILE, null);
  assert.equal(result.AWS_REGION, null);
  assert.equal(result.AWS_SECRET_ACCESS_KEY, null);
});

test('loadClaudeSettings managed mode ignores disk-only fields but inherits the whitelist', () => {
  // Isolation hardening: in managed mode the disk settings.json contributes
  // only whitelisted fields (apiKeyHelper, proxy/TLS + AWS env, cloud-provider
  // switches). model, ANTHROPIC_* routing/credential vars, and arbitrary keys
  // written by external tools must be ignored.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  writeCodeaideClaudeConfig(tempHome, 'provider-a', {
    'provider-a': {
      name: 'Provider A',
      settingsConfig: {
        model: 'provider-model',
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-provider-token',
          HTTP_PROXY: 'http://provider-proxy.example.com:8080',
        },
      },
    }
  });
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      model: 'disk-model',
      apiKeyHelper: '/usr/local/bin/get-claude-key',
      customArbitraryKey: 'should-be-dropped',
      codeaideProviderId: 'legacy-marker',
      env: {
        ANTHROPIC_MODEL: 'disk-model',
        ANTHROPIC_BASE_URL: 'https://attacker.example.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-disk-token',
        SOME_RANDOM_VAR: '1',
        HTTP_PROXY: 'http://disk-proxy.example.com:8080',
        HTTPS_PROXY: 'https://disk-proxy.example.com:8443',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        AWS_PROFILE: 'corp-bedrock',
        AWS_SECRET_ACCESS_KEY: 'disk-aws-secret',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
    }),
    'utf8'
  );

  const { settings } = runLoadClaudeSettings(tempHome);

  // Provider overlay wins for provider-managed fields.
  assert.equal(settings.model, 'provider-model');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-provider-token');
  // Whitelisted env inherited from disk...
  assert.equal(settings.env.HTTPS_PROXY, 'https://disk-proxy.example.com:8443');
  assert.equal(settings.env.NODE_EXTRA_CA_CERTS, '/etc/ssl/corp-ca.pem');
  assert.equal(settings.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  assert.equal(settings.env.AWS_PROFILE, 'corp-bedrock');
  assert.equal(settings.env.AWS_SECRET_ACCESS_KEY, 'disk-aws-secret');
  assert.equal(settings.env.CLAUDE_CODE_USE_BEDROCK, '1');
  // ...but the provider still wins per-key on whitelisted vars.
  assert.equal(settings.env.HTTP_PROXY, 'http://provider-proxy.example.com:8080');
  // Whitelisted top-level field inherited.
  assert.equal(settings.apiKeyHelper, '/usr/local/bin/get-claude-key');
  // Disk-only fields dropped.
  assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(settings.env.SOME_RANDOM_VAR, undefined);
  assert.equal(settings.customArbitraryKey, undefined);
  assert.equal(settings.codeaideProviderId, undefined);
});

test('loadClaudeSettings managed mode applies the disk whitelist even without provider settingsConfig', () => {
  // A provider entry with no settingsConfig must not reopen the whole disk
  // file — the whitelist still applies (no silent fallback to disk fields).
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
  writeCodeaideClaudeConfig(tempHome, 'provider-a', {
    'provider-a': { name: 'Provider A' }
  });
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      model: 'disk-model',
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-disk-token',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const { settings } = runLoadClaudeSettings(tempHome);

  assert.equal(settings.model, undefined);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(settings.env.HTTPS_PROXY, 'https://proxy.example.com:8443');
});

test('loadClaudeSettings returns the full disk settings for local settings / CLI login modes', () => {
  // The whitelist only constrains managed mode; user-authorized local modes
  // keep reading settings.json verbatim.
  for (const current of ['__local_settings_json__', '__cli_login__']) {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-api-config-'));
    writeCodeaideClaudeConfig(tempHome, current);
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        model: 'disk-model',
        customArbitraryKey: 'kept',
        env: {
          ANTHROPIC_MODEL: 'disk-model',
          ANTHROPIC_BASE_URL: 'https://user-chosen.example.com',
          SOME_RANDOM_VAR: '1',
        },
      }),
      'utf8'
    );

    const { settings } = runLoadClaudeSettings(tempHome);

    assert.equal(settings.model, 'disk-model', `${current} must keep full disk settings`);
    assert.equal(settings.customArbitraryKey, 'kept', `${current} must keep full disk settings`);
    assert.equal(settings.env.ANTHROPIC_MODEL, 'disk-model');
    assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://user-chosen.example.com');
    assert.equal(settings.env.SOME_RANDOM_VAR, '1');
  }
});
