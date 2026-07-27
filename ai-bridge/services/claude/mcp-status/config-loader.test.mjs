import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect HOME to a temp dir BEFORE the first call to getRealHomeDir().
// path-utils caches the resolved home on first invocation, so we lock in the
// override here and share the same temp HOME across all tests in this file.
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomeRaw = fs.mkdtempSync(path.join(os.tmpdir(), 'codeaide-mcp-config-'));
const tempHome = fs.realpathSync(tempHomeRaw);
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { loadMcpServersConfigAsRecord, loadMcpServersConfig } = await import('./config-loader.js');

const claudeJsonPath = path.join(tempHome, '.claude.json');
const codeaideMcpPath = path.join(tempHome, '.codeaide', 'mcp.json');

function writeConfig(obj) {
  fs.writeFileSync(claudeJsonPath, JSON.stringify(obj));
}

function clearConfig() {
  try { fs.unlinkSync(claudeJsonPath); } catch { /* not present */ }
}

function writeCodeaideMcp(obj) {
  fs.mkdirSync(path.dirname(codeaideMcpPath), { recursive: true });
  fs.writeFileSync(codeaideMcpPath, JSON.stringify(obj));
}

function clearCodeaideMcp() {
  try { fs.unlinkSync(codeaideMcpPath); } catch { /* not present */ }
}

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('loadMcpServersConfigAsRecord returns null when ~/.claude.json is missing', async () => {
  clearConfig();
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns null when mcpServers is absent or empty', async () => {
  writeConfig({});
  assert.equal(await loadMcpServersConfigAsRecord(), null);

  writeConfig({ mcpServers: {} });
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns null when every server is disabled', async () => {
  writeConfig({
    mcpServers: { foo: { command: 'node', args: ['s.js'] } },
    disabledMcpServers: ['foo']
  });
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns null on invalid JSON', async () => {
  fs.writeFileSync(claudeJsonPath, '{ this is not valid json');
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns Record<name, config> for enabled servers', async () => {
  writeConfig({
    mcpServers: {
      stdio: { command: 'node', args: ['server.js'] },
      http: { url: 'http://localhost:3000' }
    }
  });
  const result = await loadMcpServersConfigAsRecord();
  assert.ok(result, 'expected a non-null record');
  assert.deepEqual(Object.keys(result).sort(), ['http', 'stdio']);
  assert.deepEqual(result.stdio, { command: 'node', args: ['server.js'] });
  assert.deepEqual(result.http, { url: 'http://localhost:3000' });
});

test('loadMcpServersConfigAsRecord skips invalid server configs but keeps valid ones', async () => {
  writeConfig({
    mcpServers: {
      good: { command: 'node' },
      noCommandOrUrl: { foo: 'bar' },
      badArgs: { command: 'node', args: 'not-an-array' }
    }
  });
  const result = await loadMcpServersConfigAsRecord();
  assert.ok(result, 'expected a non-null record');
  assert.deepEqual(Object.keys(result), ['good']);
});

test('loadMcpServersConfig still returns an array (empty on missing config)', async () => {
  clearConfig();
  const list = await loadMcpServersConfig();
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 0);
});

test('~/.codeaide/mcp.json takes priority over ~/.claude.json', async () => {
  clearCodeaideMcp();
  try {
    writeConfig({
      mcpServers: { legacy: { command: 'node', args: ['legacy.js'] } }
    });
    writeCodeaideMcp({
      mcpServers: { codeaide: { command: 'node', args: ['codeaide.js'] } }
    });

    const result = await loadMcpServersConfigAsRecord();
    assert.ok(result, 'expected a non-null record');
    assert.deepEqual(Object.keys(result), ['codeaide']);
    assert.deepEqual(result.codeaide, { command: 'node', args: ['codeaide.js'] });
  } finally {
    clearCodeaideMcp();
    clearConfig();
  }
});

test('~/.claude.json is still used when ~/.codeaide/mcp.json does not exist', async () => {
  clearCodeaideMcp();
  writeConfig({
    mcpServers: { legacy: { command: 'node', args: ['legacy.js'] } }
  });
  const result = await loadMcpServersConfigAsRecord();
  assert.ok(result, 'expected a non-null record');
  assert.deepEqual(Object.keys(result), ['legacy']);
  clearConfig();
});

test('returns null when ~/.codeaide/mcp.json holds invalid JSON', async () => {
  clearConfig();
  fs.mkdirSync(path.dirname(codeaideMcpPath), { recursive: true });
  fs.writeFileSync(codeaideMcpPath, '{ not valid json');
  try {
    assert.equal(await loadMcpServersConfigAsRecord(), null);
  } finally {
    clearCodeaideMcp();
  }
});

test('codeaide mcp.json supports project-level servers and disabled lists', async () => {
  clearConfig();
  try {
    writeCodeaideMcp({
      mcpServers: { globalSrv: { command: 'node' } },
      disabledMcpServers: ['globalSrv'],
      projects: {
        '/proj/a': {
          mcpServers: { projectSrv: { url: 'http://localhost:9999' } },
          disabledMcpServers: []
        }
      }
    });

    const globalOnly = await loadMcpServersConfigAsRecord();
    assert.equal(globalOnly, null, 'globally disabled server must be filtered');

    const withProject = await loadMcpServersConfigAsRecord('/proj/a');
    assert.ok(withProject, 'expected a non-null record');
    assert.deepEqual(Object.keys(withProject), ['projectSrv']);
  } finally {
    clearCodeaideMcp();
  }
});
