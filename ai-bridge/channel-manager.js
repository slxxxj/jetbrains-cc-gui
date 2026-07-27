#!/usr/bin/env node

/**
 * AI Bridge Channel Manager
 * Unified bridge entry point for Claude and Codex SDKs
 *
 * Command format:
 *   node channel-manager.js <provider> <command> [args...]
 *
 * Provider:
 *   claude - Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
 *   codex  - Codex SDK (@openai/codex-sdk)
 *
 * Commands:
 *   send                - Send a message (parameters passed via stdin as JSON)
 *   sendWithAttachments - Send a message with attachments (claude only)
 *   getSession          - Retrieve session message history (claude only)
 *
 * Design notes:
 * - Single entry point that dispatches to different services based on the provider parameter
 * - sessionId/threadId is managed by the caller (Java side)
 * - Messages and other parameters are passed via stdin in JSON format
 */

// Shared utilities
import { readStdinData } from './utils/stdin-utils.js';
// Channel modules self-register into the registry on import.
import './channels/claude-channel.js';
import './channels/codex-channel.js';
import { getChannelHandler, listChannels } from './channels/registry.js';
import { getSdkStatus, isClaudeSdkAvailable, isCodexSdkAvailable } from './utils/sdk-loader.js';
import { injectStartupEnvVars, configureCliIdentity } from './config/api-config.js';
import { initEmitter } from './protocol/emitter.js';

// Per-process mode: business output is written as structured v2 envelopes
// ({type, data}, one NDJSON line each, no request id). Diagnostic logs go to
// stderr so they never mix into the stdout data stream (Java merges the two
// streams and surfaces stderr lines as node_log).
initEmitter(
  (obj) => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  },
  (text) => {
    process.stderr.write(text + '\n');
  }
);

// Sync proxy/TLS settings and AWS credentials from ~/.claude/settings.json
// BEFORE any network activity, but only for explicitly authorized Local
// settings.json / CLI Login modes. Without this, users behind corporate
// SSL-inspection proxies in those modes will get certificate verification
// errors, and Bedrock auth fails for desktop-launched IDEs.
injectStartupEnvVars();

// Configure CLI client identity before any SDK loading
configureCliIdentity();

// Diagnostic logging: startup info
console.log('[DIAG-ENTRY] ========== CHANNEL-MANAGER STARTUP ==========');
console.log('[DIAG-ENTRY] Node.js version:', process.version);
console.log('[DIAG-ENTRY] Platform:', process.platform);
console.log('[DIAG-ENTRY] CWD:', process.cwd());
console.log('[DIAG-ENTRY] argv:', process.argv);

// Parse command-line arguments
const provider = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

// Diagnostic logging: argument info
console.log('[DIAG-ENTRY] Provider:', provider);
console.log('[DIAG-ENTRY] Command:', command);
console.log('[DIAG-ENTRY] Args:', args);

// Error handling
process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT_ERROR]', error.message);
  console.log(JSON.stringify({
    success: false,
    error: error.message
  }));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
  console.log(JSON.stringify({
    success: false,
    error: String(reason)
  }));
  process.exit(1);
});

/**
 * Handle system-level commands (e.g., SDK status checks)
 */
async function handleSystemCommand(command, args, stdinData) {
  switch (command) {
    case 'getSdkStatus':
      // Return the installation status of all SDKs
      const status = getSdkStatus();
      console.log(JSON.stringify({
        success: true,
        data: status
      }));
      break;

    case 'checkClaudeSdk':
      // Check if Claude SDK is available
      console.log(JSON.stringify({
        success: true,
        available: isClaudeSdkAvailable()
      }));
      break;

    case 'checkCodexSdk':
      // Check if Codex SDK is available
      console.log(JSON.stringify({
        success: true,
        available: isCodexSdkAvailable()
      }));
      break;

    default:
      console.log(JSON.stringify({
        success: false,
        error: 'Unknown system command: ' + command
      }));
      process.exit(1);
  }
}

// Provider routing: every provider channel comes from the registry; 'system'
// is the only entry-point-level pseudo-provider (SDK status checks).
const SYSTEM_PROVIDER = 'system';

function resolveProviderHandler(provider) {
  if (provider === SYSTEM_PROVIDER) {
    return handleSystemCommand;
  }
  return getChannelHandler(provider);
}

function invalidProviderMessage() {
  const quoted = [...listChannels(), SYSTEM_PROVIDER].map((p) => `"${p}"`);
  const usage = quoted.length > 1
    ? `${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`
    : quoted[0];
  return 'Invalid provider. Use ' + usage;
}

// Execute command
(async () => {
  console.log('[DIAG-EXEC] ========== STARTING EXECUTION ==========');
  try {
    // Validate provider
    console.log('[DIAG-EXEC] Validating provider...');
    const handler = resolveProviderHandler(provider);
    if (!provider || !handler) {
      console.error(invalidProviderMessage());
      console.log(JSON.stringify({
        success: false,
        error: 'Invalid provider: ' + provider
      }));
      process.exit(1);
    }

    // Validate command
    if (!command) {
      console.error('No command specified');
      console.log(JSON.stringify({
        success: false,
        error: 'No command specified'
      }));
      process.exit(1);
    }

    // Read stdin data
    console.log('[DIAG-EXEC] Reading stdin data...');
    const stdinData = await readStdinData(provider);
    console.log('[DIAG-EXEC] Stdin data received, keys:', stdinData ? Object.keys(stdinData) : 'null');

    // Dispatch to the appropriate provider handler
    console.log('[DIAG-EXEC] Dispatching to handler:', provider);
    await handler(command, args, stdinData, { isDaemonMode: false });
    console.log('[DIAG-EXEC] Handler completed successfully');

    // IMPORTANT: Do not use process.exit(0) here -- it terminates the process
    // before the stdout buffer is fully flushed, which can truncate large JSON
    // output (e.g., the history returned by getSession).
    // Instead, set process.exitCode and let the process exit naturally so all I/O completes.
    process.exitCode = 0;

    // For the rewindFiles command we need to force-exit, because it restores
    // an SDK session whose MCP connections may stay open and prevent the
    // process from exiting naturally. Its output is small, so truncation is not a concern.
    if (command === 'rewindFiles') {
      // Allow a short delay for the stdout buffer to flush
      setTimeout(() => process.exit(0), 100);
    }

  } catch (error) {
    console.error('[COMMAND_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
    process.exit(1);
  }
})();
