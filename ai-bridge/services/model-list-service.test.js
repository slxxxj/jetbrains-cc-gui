import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseCodexDebugModels,
  parseAnthropicModelsResponse,
  resolveCodexBinary,
  listModels,
  clearModelListCache,
} from './model-list-service.js';

// =============================================================================
// Fixtures — shapes mirror `codex debug models` / Anthropic `/v1/models`.
// =============================================================================

const CODEX_DEBUG_MODELS_FIXTURE = JSON.stringify({
  models: [
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      description: 'Previous generation',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
      visibility: 'list',
      priority: 7,
      base_instructions: 'x'.repeat(1000),
    },
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6 Sol',
      description: 'Latest and greatest',
      default_reasoning_level: 'medium',
      visibility: 'list',
      priority: 1,
    },
    {
      slug: 'codex-auto-review',
      display_name: 'Auto Review',
      description: 'Hidden helper model',
      visibility: 'hide',
      priority: 43,
    },
    {
      slug: 'k3',
      // custom catalog entry without display_name -> label falls back to slug
      visibility: 'list',
      priority: 1000,
    },
    {
      // entry without a usable slug is dropped entirely
      display_name: 'Broken entry',
      visibility: 'list',
      priority: 2,
    },
  ],
});

const ANTHROPIC_MODELS_FIXTURE = {
  data: [
    { type: 'model', id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-01-01T00:00:00Z' },
    { type: 'model', id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2025-06-01T00:00:00Z' },
    { type: 'model', id: 'claude-haiku-4-5-20251001', created_at: '2025-04-01T00:00:00Z' },
  ],
  first_id: 'claude-opus-4-8',
  has_more: false,
  last_id: 'claude-haiku-4-5-20251001',
};

// =============================================================================
// parseCodexDebugModels
// =============================================================================

test('codex: filters to visibility=list, sorts by priority ascending, maps contract fields', () => {
  const models = parseCodexDebugModels(CODEX_DEBUG_MODELS_FIXTURE);

  assert.deepEqual(
    models.map((m) => m.id),
    ['gpt-5.6-sol', 'gpt-5.5', 'k3'],
  );
  assert.equal(models[0].label, 'GPT-5.6 Sol');
  assert.equal(models[0].description, 'Latest and greatest');
  // label falls back to slug when display_name is absent
  assert.equal(models[2].label, 'k3');
  assert.equal(models[2].description, '');
  // hidden / malformed entries never leak through
  assert.ok(!models.some((m) => m.id === 'codex-auto-review'));
});

test('codex: entries without numeric priority sort last, keeping output stable', () => {
  const fixture = JSON.stringify({
    models: [
      { slug: 'no-priority', visibility: 'list' },
      { slug: 'first', visibility: 'list', priority: 1 },
    ],
  });
  const models = parseCodexDebugModels(fixture);
  assert.deepEqual(models.map((m) => m.id), ['first', 'no-priority']);
});

test('codex: accepts a top-level array as well as {models:[...]}', () => {
  const models = parseCodexDebugModels(JSON.stringify([{ slug: 'm1', visibility: 'list', priority: 1 }]));
  assert.deepEqual(models, [{ id: 'm1', label: 'm1', description: '' }]);
});

test('codex: tolerates log noise surrounding the JSON payload', () => {
  const noisy = `some warning line\n${CODEX_DEBUG_MODELS_FIXTURE}\ntrailing noise`;
  const models = parseCodexDebugModels(noisy);
  assert.equal(models.length, 3);
});

test('codex: throws on non-JSON output and on missing models array', () => {
  assert.throws(() => parseCodexDebugModels('not json at all'));
  assert.throws(() => parseCodexDebugModels(JSON.stringify({ unexpected: true })));
});

// =============================================================================
// parseAnthropicModelsResponse
// =============================================================================

test('claude: maps data array to contract fields with label fallback', () => {
  const models = parseAnthropicModelsResponse(ANTHROPIC_MODELS_FIXTURE);

  assert.equal(models.length, 3);
  assert.deepEqual(models[0], { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', description: '' });
  // display_name missing -> label falls back to id
  assert.equal(models[2].label, 'claude-haiku-4-5-20251001');
});

test('claude: accepts a raw JSON string body', () => {
  const models = parseAnthropicModelsResponse(JSON.stringify(ANTHROPIC_MODELS_FIXTURE));
  assert.equal(models.length, 3);
});

test('claude: drops entries without id and throws when data is missing', () => {
  const models = parseAnthropicModelsResponse({ data: [{ display_name: 'no id' }, { id: 'ok' }] });
  assert.deepEqual(models, [{ id: 'ok', label: 'ok', description: '' }]);

  assert.throws(() => parseAnthropicModelsResponse({ objects: [] }));
  assert.throws(() => parseAnthropicModelsResponse('not json'));
});

// =============================================================================
// resolveCodexBinary (path resolution only — no process spawning)
// =============================================================================

function makeSdkRoot(layout) {
  const root = mkdtempSync(join(tmpdir(), 'codex-sdk-'));
  const vendorDir = join(root, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc');
  const binDir = join(vendorDir, layout === 'legacy' ? 'codex' : 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'codex.exe'), 'MZ-fake');
  return root;
}

test('codex binary: resolves current bin/ layout', () => {
  const root = makeSdkRoot('bin');
  const resolved = resolveCodexBinary(root, 'win32', 'x64');
  assert.ok(resolved.endsWith(join('bin', 'codex.exe')));
});

test('codex binary: falls back to legacy codex/ layout', () => {
  const root = makeSdkRoot('legacy');
  const resolved = resolveCodexBinary(root, 'win32', 'x64');
  assert.ok(resolved.endsWith(join('codex', 'codex.exe')));
});

test('codex binary: uses codex (no .exe) on posix and null for unknown platform/arch', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-sdk-'));
  const binDir = join(root, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'codex'), '#!/bin/sh\n');
  assert.ok(resolveCodexBinary(root, 'darwin', 'arm64').endsWith(join('bin', 'codex')));

  assert.equal(resolveCodexBinary(root, 'freebsd', 'x64'), null);
  assert.equal(resolveCodexBinary(mkdtempSync(join(tmpdir(), 'codex-sdk-empty-')), 'win32', 'x64'), null);
});

// =============================================================================
// listModels guard rails (no process/network — validation happens first)
// =============================================================================

test('listModels: rejects unknown providers before doing any work', async () => {
  await assert.rejects(() => listModels('gemini'), /Unknown provider/);
});

test('cache: clearing the model list cache is safe when empty', () => {
  clearModelListCache();
});
