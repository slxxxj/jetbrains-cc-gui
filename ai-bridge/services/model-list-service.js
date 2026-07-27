/**
 * Model List Service — dynamically resolves the available model catalog per
 * provider for the webview model selector.
 *
 * - codex:  runs the vendored Codex CLI `debug models` subcommand (the same
 *   binary @openai/codex-sdk spawns) and parses its JSON catalog. User-defined
 *   model catalogs (e.g. cc-switch's model_catalog_json) are included because
 *   `--bundled` is intentionally NOT passed.
 * - claude: calls the Anthropic-compatible `GET {baseUrl}/v1/models` endpoint
 *   with the managed-provider credentials resolved by config/api-config.js.
 *
 * Both paths are best-effort: any failure (SDK not installed, CLI error,
 * unsupported auth mode, network timeout, malformed output) yields
 * `{ source: 'fallback' }` so the webview falls back to its built-in list.
 * `debug models` is not an officially stable API, so every assumption about
 * its output is validated defensively.
 *
 * Successful dynamic results are cached in memory per provider (default TTL
 * 10 minutes); failures are never cached so a transient error does not stick.
 *
 * Result shape (contract with the Java side / webview):
 *   { provider: 'claude'|'codex',
 *     models: [{ id, label, description }],
 *     source: 'dynamic'|'fallback',
 *     error?: string }
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setupApiKey } from '../config/api-config.js';
import { getCodeaideDir } from '../utils/path-utils.js';
import { buildCodexCliEnvironment } from './codex/codex-utils.js';

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const CODEX_DEBUG_MODELS_TIMEOUT_MS = 10_000;
// A single model entry can reach ~47KB (base_instructions etc.), and busy
// catalogs hold dozens of entries, so the default 1MB execFile cap is unsafe.
const CODEX_DEBUG_MODELS_MAX_BUFFER = 32 * 1024 * 1024;
const CLAUDE_MODELS_TIMEOUT_MS = 5_000;
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION_HEADER = '2023-06-01';

const SUPPORTED_PROVIDERS = new Set(['claude', 'codex']);

// provider -> { models: Array, fetchedAt: number }. Only dynamic successes
// are stored; fallback results always re-run on the next request.
const modelCache = new Map();

// =============================================================================
// Codex: `codex debug models`
// =============================================================================

/**
 * Map (platform, arch) to the codex-sdk target triple / platform package.
 * Mirrors PLATFORM_PACKAGE_BY_TARGET in @openai/codex-sdk (dist/index.js).
 */
const CODEX_PLATFORM_PACKAGES = {
  'linux:x64': { triple: 'x86_64-unknown-linux-musl', pkg: '@openai/codex-linux-x64' },
  'linux:arm64': { triple: 'aarch64-unknown-linux-musl', pkg: '@openai/codex-linux-arm64' },
  'darwin:x64': { triple: 'x86_64-apple-darwin', pkg: '@openai/codex-darwin-x64' },
  'darwin:arm64': { triple: 'aarch64-apple-darwin', pkg: '@openai/codex-darwin-arm64' },
  'win32:x64': { triple: 'x86_64-pc-windows-msvc', pkg: '@openai/codex-win32-x64' },
  'win32:arm64': { triple: 'aarch64-pc-windows-msvc', pkg: '@openai/codex-win32-arm64' },
};

/**
 * Locate the vendored Codex CLI binary inside the plugin-managed codex-sdk
 * dependency directory. Replicates the SDK's own resolution: the platform
 * package ships vendor/<triple>/bin/codex (current layout) or the legacy
 * vendor/<triple>/codex/codex.
 *
 * @param {string} [sdkRootDir] codex-sdk root (defaults to ~/.codeaide/dependencies/codex-sdk)
 * @param {string} [platform] process.platform override (for tests)
 * @param {string} [arch] process.arch override (for tests)
 * @returns {string|null} absolute binary path, or null when not installed
 */
export function resolveCodexBinary(
  sdkRootDir = join(getCodeaideDir(), 'dependencies', 'codex-sdk'),
  platform = process.platform,
  arch = process.arch,
) {
  const target = CODEX_PLATFORM_PACKAGES[`${platform}:${arch}`];
  if (!target) {
    return null;
  }
  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
  const packageRoot = join(sdkRootDir, 'node_modules', ...target.pkg.split('/'));
  const vendorDir = join(packageRoot, 'vendor', target.triple);
  const candidates = [
    join(vendorDir, 'bin', binaryName),
    join(vendorDir, 'codex', binaryName), // legacy layout
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Parse the JSON catalog printed by `codex debug models`: keep only entries
 * whose visibility is "list", order by ascending priority (the CLI's display
 * order — newer/default models carry lower numbers), and map to the
 * {id, label, description} contract shape.
 *
 * @param {string} stdout raw process stdout
 * @returns {Array<{id: string, label: string, description: string}>}
 * @throws {Error} when stdout is not valid JSON or has no models array
 */
export function parseCodexDebugModels(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (firstError) {
    // `debug models` is not an official API: tolerate log noise around the
    // JSON payload by slicing from the first '{' to the last '}'.
    const start = typeof stdout === 'string' ? stdout.indexOf('{') : -1;
    const end = typeof stdout === 'string' ? stdout.lastIndexOf('}') : -1;
    if (start < 0 || end <= start) {
      throw firstError;
    }
    parsed = JSON.parse(stdout.slice(start, end + 1));
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.models;
  if (!Array.isArray(entries)) {
    throw new Error('codex debug models output has no "models" array');
  }
  return entries
    .filter((m) => m && typeof m === 'object' && m.visibility === 'list' && typeof m.slug === 'string' && m.slug)
    .sort((a, b) => {
      const pa = typeof a.priority === 'number' ? a.priority : Number.MAX_SAFE_INTEGER;
      const pb = typeof b.priority === 'number' ? b.priority : Number.MAX_SAFE_INTEGER;
      return pa - pb;
    })
    .map((m) => ({
      id: m.slug,
      label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug,
      description: typeof m.description === 'string' ? m.description : '',
    }));
}

function runCodexDebugModels(binaryPath) {
  return new Promise((resolve, reject) => {
    const { cliEnv } = buildCodexCliEnvironment(process.env);
    execFile(
      binaryPath,
      ['debug', 'models'],
      {
        timeout: CODEX_DEBUG_MODELS_TIMEOUT_MS,
        maxBuffer: CODEX_DEBUG_MODELS_MAX_BUFFER,
        env: cliEnv,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function listCodexModels() {
  const binary = resolveCodexBinary();
  if (!binary) {
    return { provider: 'codex', models: [], source: 'fallback', error: 'Codex CLI binary not found (SDK not installed)' };
  }
  try {
    const stdout = await runCodexDebugModels(binary);
    const models = parseCodexDebugModels(stdout);
    if (models.length === 0) {
      return { provider: 'codex', models: [], source: 'fallback', error: 'codex debug models returned no list-visible models' };
    }
    return { provider: 'codex', models, source: 'dynamic' };
  } catch (error) {
    return { provider: 'codex', models: [], source: 'fallback', error: `codex debug models failed: ${error.message}` };
  }
}

// =============================================================================
// Claude: GET {baseUrl}/v1/models
// =============================================================================

/**
 * Map the Anthropic /v1/models response body to the contract shape.
 * Accepts either a parsed object ({data: [...]}) or a raw JSON string.
 *
 * @param {object|string} body
 * @returns {Array<{id: string, label: string, description: string}>}
 * @throws {Error} when the body has no data array
 */
export function parseAnthropicModelsResponse(body) {
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  const entries = Array.isArray(parsed) ? parsed : parsed?.data;
  if (!Array.isArray(entries)) {
    throw new Error('/v1/models response has no "data" array');
  }
  return entries
    .filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id)
    .map((m) => ({
      id: m.id,
      label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id,
      description: typeof m.description === 'string' ? m.description : '',
    }));
}

async function listClaudeModels() {
  let credentials;
  try {
    credentials = setupApiKey();
  } catch (error) {
    return { provider: 'claude', models: [], source: 'fallback', error: `credentials unavailable: ${error.message}` };
  }

  const { apiKey, baseUrl, authType } = credentials || {};
  // Only plain HTTP credential modes can call /v1/models directly. Bedrock,
  // CLI-login (OAuth) and apiKeyHelper modes have no static bearer token here.
  if ((authType !== 'api_key' && authType !== 'auth_token') || !apiKey) {
    return {
      provider: 'claude',
      models: [],
      source: 'fallback',
      error: `unsupported auth type for /v1/models: ${authType || 'unknown'}`,
    };
  }

  const normalizedBase = (baseUrl || ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = { 'anthropic-version': ANTHROPIC_VERSION_HEADER };
  if (authType === 'auth_token') {
    headers.authorization = `Bearer ${apiKey}`;
  } else {
    headers['x-api-key'] = apiKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(`${normalizedBase}/v1/models?limit=1000`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        provider: 'claude',
        models: [],
        source: 'fallback',
        error: `/v1/models responded HTTP ${response.status}`,
      };
    }
    const models = parseAnthropicModelsResponse(await response.json());
    if (models.length === 0) {
      return { provider: 'claude', models: [], source: 'fallback', error: '/v1/models returned an empty list' };
    }
    return { provider: 'claude', models, source: 'dynamic' };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `timed out after ${CLAUDE_MODELS_TIMEOUT_MS}ms` : error.message;
    return { provider: 'claude', models: [], source: 'fallback', error: `/v1/models failed: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
// Entry point + cache
// =============================================================================

/**
 * List available models for a provider.
 *
 * @param {'claude'|'codex'} provider
 * @param {object} [options]
 * @param {boolean} [options.refresh] bypass the cache and re-fetch
 * @param {number} [options.cacheTtlMs] cache TTL override (for tests)
 * @returns {Promise<{provider: string, models: Array, source: 'dynamic'|'fallback', error?: string}>}
 */
export async function listModels(provider, options = {}) {
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unknown provider for listModels: ${provider}`);
  }
  const { refresh = false, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = options;

  if (!refresh) {
    const cached = modelCache.get(provider);
    if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
      return { provider, models: cached.models, source: 'dynamic' };
    }
  }

  const result = provider === 'codex' ? await listCodexModels() : await listClaudeModels();
  if (result.source === 'dynamic') {
    modelCache.set(provider, { models: result.models, fetchedAt: Date.now() });
  }
  return result;
}

/**
 * Clear the in-memory model cache (test hook).
 */
export function clearModelListCache() {
  modelCache.clear();
}
