/**
 * SDK Loader - Dynamically loads optional AI SDKs
 *
 * Supports loading SDKs from the user directory ~/.codeaide/dependencies/
 * This allows users to install SDKs on demand rather than bundling them with the plugin
 *
 * SDK definitions are no longer hardcoded here: each channel declares its SDK
 * descriptor ({ id, npmPackage, cacheKey, notInstalledMessage }) when it
 * registers in channels/registry.js (built-in descriptors live in
 * channels/sdk-descriptors.js). The legacy claude/codex-named exports remain
 * as delegating wrappers so existing imports keep working.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { getRealHomeDir, getCodeaideDir } from './path-utils.js';
import { getChannelSdkDescriptor, listChannels } from '../channels/registry.js';

// Base path for dependencies directory - uses the shared path utility
const DEPS_BASE = join(getCodeaideDir(), 'dependencies');

// SDK cache
const sdkCache = new Map();
// Promise cache for in-flight loads to prevent concurrent loading of the same SDK
const loadingPromises = new Map();

/**
 * Resolve the SDK descriptor a channel declared for the given provider.
 * @param {string} provider - e.g. 'claude', 'codex'
 * @returns {object} { id, npmPackage, cacheKey, displayName, notInstalledMessage }
 * @throws {Error} If no channel registered an SDK descriptor for the provider
 */
function getSdkDescriptor(provider) {
    const descriptor = getChannelSdkDescriptor(provider);
    if (!descriptor) {
        throw new Error(`No SDK descriptor registered for provider: ${provider}`);
    }
    return descriptor;
}

function getSdkRootDir(sdkId) {
    return join(DEPS_BASE, sdkId);
}

function getPackageDirFromRoot(sdkRootDir, pkgName) {
    // pkgName like: "@anthropic-ai/claude-agent-sdk" or "@openai/codex-sdk"
    // Logic kept consistent with DependencyManager.getPackageDir()
    const parts = pkgName.split('/');
    return join(sdkRootDir, 'node_modules', ...parts);
}

function pickExportTarget(exportsField, condition) {
    if (!exportsField) return null;
    if (typeof exportsField === 'string') return exportsField;

    // exports: { ".": {...} } or exports: { import: "...", require: "...", default: "..." }
    const root = exportsField['.'] ?? exportsField;
    if (typeof root === 'string') return root;

    if (root && typeof root === 'object') {
        if (typeof root[condition] === 'string') return root[condition];
        if (typeof root.default === 'string') return root.default;
    }

    return null;
}

function resolveEntryFileFromPackageDir(packageDir) {
    // Node ESM does not support importing a directory path directly.
    // We must resolve to a concrete file (e.g., sdk.mjs / index.js / export target).
    const pkgJsonPath = join(packageDir, 'package.json');
    if (existsSync(pkgJsonPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

            const exportTarget =
                pickExportTarget(pkg.exports, 'import') ??
                pickExportTarget(pkg.exports, 'default');

            const candidate =
                exportTarget ??
                (typeof pkg.module === 'string' ? pkg.module : null) ??
                (typeof pkg.main === 'string' ? pkg.main : null);

            if (candidate && typeof candidate === 'string') {
                return join(packageDir, candidate);
            }
        } catch {
            // ignore and fall through to heuristic
        }
    }

    // Heuristics (covers @anthropic-ai/claude-agent-sdk which has sdk.mjs)
    const heuristicCandidates = ['sdk.mjs', 'index.mjs', 'index.js', 'dist/index.js', 'dist/index.mjs'];
    for (const file of heuristicCandidates) {
        const full = join(packageDir, file);
        if (existsSync(full)) return full;
    }

    return null;
}

function resolveExternalPackageUrl(pkgName, sdkRootDir) {
    // Resolve from package directory (works for external node_modules without touching Node's default resolver)
    const packageDir = getPackageDirFromRoot(sdkRootDir, pkgName);
    const entry = resolveEntryFileFromPackageDir(packageDir);
    if (!entry) {
        throw new Error(`Unable to resolve entry file for ${pkgName} from ${packageDir}`);
    }
    return pathToFileURL(entry).href;
}

/**
 * Check whether a provider's SDK is available, using the SDK descriptor the
 * channel declared at registration.
 * Logic kept consistent with DependencyManager.isInstalled(provider)
 * @param {string} provider - e.g. 'claude', 'codex'
 */
export function isSdkAvailable(provider) {
    const descriptor = getSdkDescriptor(provider);
    const sdkPath = getPackageDirFromRoot(getSdkRootDir(descriptor.id), descriptor.npmPackage);
    return existsSync(sdkPath);
}

/**
 * Check whether the Claude Code SDK is available
 * Logic kept consistent with DependencyManager.isInstalled("claude")
 */
export function isClaudeSdkAvailable() {
    const descriptor = getSdkDescriptor('claude');
    const sdkPath = getPackageDirFromRoot(getSdkRootDir(descriptor.id), descriptor.npmPackage);
    const exists = existsSync(sdkPath);
    console.log('[sdk-loader] isClaudeSdkAvailable:', {
        path: sdkPath,
        exists: exists,
        depsBase: DEPS_BASE
    });
    return exists;
}

/**
 * Check whether the Codex SDK is available
 * Logic kept consistent with DependencyManager.isInstalled("codex")
 */
export function isCodexSdkAvailable() {
    const descriptor = getSdkDescriptor('codex');
    const sdkPath = getPackageDirFromRoot(getSdkRootDir(descriptor.id), descriptor.npmPackage);
    const exists = existsSync(sdkPath);
    console.log('[sdk-loader] isCodexSdkAvailable:', {
        path: sdkPath,
        exists: exists
    });
    return exists;
}

/**
 * Dynamically load the Claude SDK
 * @returns {Promise<{query: Function, ...}>}
 * @throws {Error} If the SDK is not installed
 */
export async function loadClaudeSdk() {
    console.log('[DIAG-SDK] loadClaudeSdk() called');

    const descriptor = getSdkDescriptor('claude');
    const cacheKey = descriptor.cacheKey;

    // Return the cached SDK if available
    if (sdkCache.has(cacheKey)) {
        console.log('[DIAG-SDK] Returning cached SDK');
        return sdkCache.get(cacheKey);
    }

    // If a load is already in progress, return the same promise to prevent duplicate loading
    if (loadingPromises.has(cacheKey)) {
        console.log('[DIAG-SDK] SDK loading in progress, returning existing promise');
        return loadingPromises.get(cacheKey);
    }

    const sdkRootDir = getSdkRootDir(descriptor.id);
    const sdkPath = getPackageDirFromRoot(sdkRootDir, descriptor.npmPackage);
    console.log('[DIAG-SDK] SDK path:', sdkPath);
    console.log('[DIAG-SDK] SDK path exists:', existsSync(sdkPath));

    if (!existsSync(sdkPath)) {
        console.log('[DIAG-SDK] SDK not installed at path');
        throw new Error('SDK_NOT_INSTALLED:claude');
    }

    // Create and cache the loading promise
    const loadPromise = (async () => {
        try {
            console.log('[DIAG-SDK] SDK root dir:', sdkRootDir);

            // Node ESM does not support import(directory); must resolve to a concrete file (e.g. sdk.mjs)
            const resolvedUrl = resolveExternalPackageUrl(descriptor.npmPackage, sdkRootDir);
            console.log('[DIAG-SDK] Resolved URL:', resolvedUrl);

            console.log('[DIAG-SDK] Starting dynamic import...');
            const sdk = await import(resolvedUrl);
            console.log('[DIAG-SDK] SDK imported successfully, exports:', Object.keys(sdk));

            sdkCache.set(cacheKey, sdk);
            return sdk;
        } catch (error) {
            console.log('[DIAG-SDK] SDK import failed:', error.message);
            const pkgDir = getPackageDirFromRoot(sdkRootDir, descriptor.npmPackage);
            const hintFile = join(pkgDir, 'sdk.mjs');
            const hint = existsSync(hintFile) ? ` Did you mean to import ${hintFile}?` : '';
            throw new Error(`Failed to load Claude SDK: ${error.message}${hint}`);
        } finally {
            // Clear the promise cache once loading is complete
            loadingPromises.delete(cacheKey);
        }
    })();

    loadingPromises.set(cacheKey, loadPromise);
    return loadPromise;
}

/**
 * Dynamically load a provider's SDK, using the SDK descriptor the channel
 * declared at registration.
 * @param {string} provider - e.g. 'codex'
 * @returns {Promise<object>} The loaded SDK module
 * @throws {Error} If the SDK is not installed
 */
export async function loadSdk(provider) {
    const descriptor = getSdkDescriptor(provider);
    const cacheKey = descriptor.cacheKey;

    // Return the cached SDK if available
    if (sdkCache.has(cacheKey)) {
        return sdkCache.get(cacheKey);
    }

    // If a load is already in progress, return the same promise to prevent duplicate loading
    if (loadingPromises.has(cacheKey)) {
        return loadingPromises.get(cacheKey);
    }

    const sdkRootDir = getSdkRootDir(descriptor.id);
    const sdkPath = getPackageDirFromRoot(sdkRootDir, descriptor.npmPackage);

    if (!existsSync(sdkPath)) {
        throw new Error(`SDK_NOT_INSTALLED:${provider}`);
    }

    // Create and cache the loading promise
    const loadPromise = (async () => {
        try {
            const resolvedUrl = resolveExternalPackageUrl(descriptor.npmPackage, sdkRootDir);
            const sdk = await import(resolvedUrl);

            sdkCache.set(cacheKey, sdk);
            return sdk;
        } catch (error) {
            throw new Error(`Failed to load ${descriptor.displayName}: ${error.message}`);
        } finally {
            loadingPromises.delete(cacheKey);
        }
    })();

    loadingPromises.set(cacheKey, loadPromise);
    return loadPromise;
}

/**
 * Dynamically load the Codex SDK
 * @returns {Promise<{Codex: Class, ...}>}
 * @throws {Error} If the SDK is not installed
 */
export async function loadCodexSdk() {
    return loadSdk('codex');
}

/**
 * Load the base Anthropic SDK (used as an API fallback)
 * @returns {Promise<{Anthropic: Class}>}
 */
export async function loadAnthropicSdk() {
    // Return the cached SDK if available
    if (sdkCache.has('anthropic')) {
        return sdkCache.get('anthropic');
    }

    // If a load is already in progress, return the same promise to prevent duplicate loading
    if (loadingPromises.has('anthropic')) {
        return loadingPromises.get('anthropic');
    }

    const sdkRootDir = getSdkRootDir(getSdkDescriptor('claude').id);
    const sdkPath = join(sdkRootDir, 'node_modules', '@anthropic-ai', 'sdk');

    if (!existsSync(sdkPath)) {
        throw new Error('SDK_NOT_INSTALLED:anthropic');
    }

    // Create and cache the loading promise
    const loadPromise = (async () => {
        try {
            const resolvedUrl = resolveExternalPackageUrl('@anthropic-ai/sdk', sdkRootDir);
            const sdk = await import(resolvedUrl);

            sdkCache.set('anthropic', sdk);
            return sdk;
        } catch (error) {
            throw new Error(`Failed to load Anthropic SDK: ${error.message}`);
        } finally {
            loadingPromises.delete('anthropic');
        }
    })();

    loadingPromises.set('anthropic', loadPromise);
    return loadPromise;
}

/**
 * Load the Bedrock SDK
 * @returns {Promise<{AnthropicBedrock: Class}>}
 */
export async function loadBedrockSdk() {
    // Return the cached SDK if available
    if (sdkCache.has('bedrock')) {
        return sdkCache.get('bedrock');
    }

    // If a load is already in progress, return the same promise to prevent duplicate loading
    if (loadingPromises.has('bedrock')) {
        return loadingPromises.get('bedrock');
    }

    const sdkRootDir = getSdkRootDir(getSdkDescriptor('claude').id);
    const sdkPath = join(sdkRootDir, 'node_modules', '@anthropic-ai', 'bedrock-sdk');

    if (!existsSync(sdkPath)) {
        throw new Error('SDK_NOT_INSTALLED:bedrock');
    }

    // Create and cache the loading promise
    const loadPromise = (async () => {
        try {
            const resolvedUrl = resolveExternalPackageUrl('@anthropic-ai/bedrock-sdk', sdkRootDir);
            const sdk = await import(resolvedUrl);

            sdkCache.set('bedrock', sdk);
            return sdk;
        } catch (error) {
            throw new Error(`Failed to load Bedrock SDK: ${error.message}`);
        } finally {
            loadingPromises.delete('bedrock');
        }
    })();

    loadingPromises.set('bedrock', loadPromise);
    return loadPromise;
}

/**
 * Get the installation status of all SDKs
 */
export function getSdkStatus() {
    // Uses the same path resolution logic as DependencyManager
    const status = {};
    for (const provider of listChannels()) {
        const descriptor = getChannelSdkDescriptor(provider);
        if (!descriptor) {
            continue;
        }
        status[provider] = {
            installed: isSdkAvailable(provider),
            path: getPackageDirFromRoot(getSdkRootDir(descriptor.id), descriptor.npmPackage)
        };
    }
    return status;
}

/**
 * Clear the SDK cache
 * Should be called after an SDK is reinstalled
 */
export function clearSdkCache() {
    sdkCache.clear();
}

/**
 * Verify that the SDK is installed, throwing a user-friendly error if not
 * @param {string} provider - 'claude' or 'codex'
 * @throws {Error} If the SDK is not installed
 */
export function requireSdk(provider) {
    const descriptor = getChannelSdkDescriptor(provider);
    // Unknown provider: nothing to require (legacy behavior for names other
    // than claude/codex was a silent no-op).
    if (!descriptor) {
        return;
    }

    if (!isSdkAvailable(provider)) {
        const error = new Error(descriptor.notInstalledMessage);
        error.code = 'SDK_NOT_INSTALLED';
        error.provider = provider;
        throw error;
    }
}
