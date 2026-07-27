/**
 * Channel registry — single lookup point mapping a provider name to its
 * channel handler and the SDK descriptor the channel declares at registration
 * time.
 *
 * Both entry points dispatch through this registry so provider routing lives
 * in exactly one place:
 * - channel-manager.js (per-process mode) passes { isDaemonMode: false }
 * - daemon.js (persistent mode) passes { isDaemonMode: true }
 *
 * Channel handler signature:
 *   async (command: string, args: string[], stdinData: object|null,
 *          context?: { isDaemonMode?: boolean }) => void
 *
 * Channels self-register their handler at module load (see claude-channel.js /
 * codex-channel.js); entry points import the channel modules for that side
 * effect. SDK descriptors are pure data and are pre-registered from
 * sdk-descriptors.js so low-level consumers (utils/sdk-loader.js) resolve them
 * even when the channel implementation modules have not been imported.
 *
 * To add a provider, declare its SDK descriptor in sdk-descriptors.js and
 * create a channel file that calls registerChannel().
 */

import { CHANNEL_SDK_DESCRIPTORS } from './sdk-descriptors.js';

const channels = new Map();

/**
 * Register a channel handler for a provider.
 * @param {string} name provider name (e.g. 'claude', 'codex')
 * @param {Function} handler async (command, args, stdinData, context) => void
 * @param {object} [options]
 * @param {object} [options.sdk] SDK descriptor consumed by utils/sdk-loader.js:
 *   { id: string, npmPackage: string, cacheKey: string, displayName: string,
 *     notInstalledMessage: string }. Defaults to the descriptor declared in
 *   sdk-descriptors.js for this provider.
 */
export function registerChannel(name, handler, options = {}) {
  if (!name || typeof handler !== 'function') {
    throw new Error('registerChannel requires a provider name and a handler function');
  }
  const existing = channels.get(name);
  channels.set(name, {
    name,
    handler,
    sdk: options.sdk || (existing ? existing.sdk : null),
  });
}

/**
 * Pre-register an SDK descriptor without a handler. Used for the built-in
 * channels so sdk-loader works independently of channel-module load order.
 */
function registerChannelSdk(name, sdk) {
  const existing = channels.get(name);
  channels.set(name, {
    name,
    handler: existing ? existing.handler : null,
    sdk,
  });
}

for (const [name, sdk] of Object.entries(CHANNEL_SDK_DESCRIPTORS)) {
  registerChannelSdk(name, sdk);
}

/**
 * Get the registered channel record ({ name, handler, sdk }) for a provider,
 * or null when the provider is not registered.
 */
export function getChannel(name) {
  return channels.get(name) || null;
}

/**
 * Get the registered channel handler for a provider, or null when the
 * provider is unknown or its channel module has not been imported.
 */
export function getChannelHandler(name) {
  const channel = channels.get(name);
  return channel ? channel.handler : null;
}

/**
 * Get the SDK descriptor a channel declared at registration time, or null.
 */
export function getChannelSdkDescriptor(name) {
  const channel = channels.get(name);
  return channel ? channel.sdk : null;
}

/**
 * List registered provider names, in registration order.
 */
export function listChannels() {
  return [...channels.keys()];
}
