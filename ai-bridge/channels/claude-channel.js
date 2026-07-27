/**
 * Claude channel command handler – isolates all Claude specific command logic
 * away from the shared channel-manager entry point.
 *
 * The same handler serves both dispatch modes (see channels/registry.js):
 * - per-process mode (channel-manager.js): runs commands against one-shot
 *   services; commands that need a persistent runtime report an error.
 * - daemon mode (daemon.js): send-family and runtime commands run against the
 *   persistent query service so they reuse the warm runtime.
 */
import {
  sendMessage as claudeSendMessage,
  sendMessageWithAttachments as claudeSendMessageWithAttachments,
  rewindFiles as claudeRewindFiles,
  getMcpServerStatus as claudeGetMcpServerStatus,
  getMcpServerTools as claudeGetMcpServerTools
} from '../services/claude/message-service.js';
import {
  sendMessagePersistent as claudeSendMessagePersistent,
  sendMessageWithAttachmentsPersistent as claudeSendMessageWithAttachmentsPersistent,
  preconnectPersistent as claudePreconnectPersistent,
  resetRuntimePersistent as claudeResetRuntimePersistent,
  getContextUsagePersistent as claudeGetContextUsagePersistent,
  setPermissionModePersistent as claudeSetPermissionModePersistent
} from '../services/claude/persistent-query-service.js';
import {
  getSessionMessages as claudeGetSessionMessages,
  getLatestUserMessage as claudeGetLatestUserMessage
} from '../services/claude/session-service.js';
import { listModels } from '../services/model-list-service.js';
import { emit } from '../protocol/emitter.js';
import { registerChannel } from './registry.js';
import { CLAUDE_SDK_DESCRIPTOR } from './sdk-descriptors.js';

/**
 * Execute a Claude specific command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 * @param {object} [context] dispatch context; { isDaemonMode: true } when the
 *   long-running daemon dispatches the command (persistent runtime available)
 */
export async function handleClaudeCommand(command, args, stdinData, context) {
  const isDaemonMode = context?.isDaemonMode === true;
  switch (command) {
    case 'send': {
      if (isDaemonMode) {
        // Daemon mode: reuse the persistent runtime instead of spawning a
        // per-request process.
        await claudeSendMessagePersistent(stdinData || {});
        break;
      }
      if (stdinData && stdinData.message !== undefined) {
        // Include streaming and disableThinking when destructuring
        const { message, sessionId, cwd, permissionMode, model, openedFiles, agentPrompt, streaming, disableThinking, reasoningEffort, subagentModel, chatMode } = stdinData;
        await claudeSendMessage(
          message,
          sessionId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          openedFiles || null,
          agentPrompt || null,
          streaming,  // Pass streaming parameter
          disableThinking || false,  // Pass disableThinking parameter
          reasoningEffort || null,  // Pass reasoning effort level
          subagentModel || null,  // Pass subagent model override
          chatMode || null  // Pass per-message chat mode
        );
      } else {
        await claudeSendMessage(args[0], args[1], args[2], args[3], args[4]);
      }
      break;
    }

    case 'sendWithAttachments': {
      if (isDaemonMode) {
        await claudeSendMessageWithAttachmentsPersistent(stdinData || {});
        break;
      }
      if (stdinData && stdinData.message !== undefined) {
        // Include streaming when destructuring
        const { message, sessionId, cwd, permissionMode, model, attachments, openedFiles, agentPrompt, streaming, reasoningEffort, subagentModel, chatMode } = stdinData;
        await claudeSendMessageWithAttachments(
          message,
          sessionId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          attachments ? { attachments, openedFiles, agentPrompt, streaming, reasoningEffort, subagentModel } : { openedFiles, agentPrompt, streaming, reasoningEffort, subagentModel },
          chatMode || null  // Pass per-message chat mode
        );
      } else {
        await claudeSendMessageWithAttachments(args[0], args[1], args[2], args[3], args[4], stdinData);
      }
      break;
    }

    case 'getSession':
      await claudeGetSessionMessages(args[0], args[1]);
      break;

    case 'getLatestUserMessage':
      await claudeGetLatestUserMessage(args[0], args[1]);
      break;

    case 'rewindFiles': {
      const sessionId = stdinData?.sessionId || args[0];
      const userMessageId = stdinData?.userMessageId || args[1];
      const cwd = stdinData?.cwd || args[2] || null;
      if (!sessionId || !userMessageId) {
        console.log(JSON.stringify({
          success: false,
          error: 'Missing required parameters: sessionId and userMessageId'
        }));
        return;
      }
      await claudeRewindFiles(sessionId, userMessageId, cwd);
      break;
    }

    case 'getMcpServerStatus': {
      const cwd = stdinData?.cwd || args[0] || null;
      await claudeGetMcpServerStatus(cwd);
      break;
    }

    case 'getMcpServerTools': {
      const serverId = stdinData?.serverId || args[0] || null;
      const cwd = stdinData?.cwd || args[1] || null;
      await claudeGetMcpServerTools(serverId, cwd);
      break;
    }

    case 'preconnect': {
      if (!isDaemonMode) {
        throw new Error(`Unknown Claude command: ${command}`);
      }
      await claudePreconnectPersistent(stdinData || {});
      break;
    }

    case 'resetRuntime': {
      await claudeResetRuntimePersistent(stdinData || {});
      break;
    }

    case 'getContextUsage': {
      if (isDaemonMode) {
        await claudeGetContextUsagePersistent(stdinData || {});
        break;
      }
      // getContextUsage requires a persistent runtime (daemon mode).
      // In per-process mode, there is no persistent runtime, so return an error.
      console.log(JSON.stringify({
        success: false,
        error: 'getContextUsage requires daemon mode. No persistent runtime available in per-process mode.'
      }));
      break;
    }

    case 'setPermissionMode': {
      if (!isDaemonMode) {
        throw new Error(`Unknown Claude command: ${command}`);
      }
      await claudeSetPermissionModePersistent(stdinData || {});
      break;
    }

    case 'listModels': {
      // Dynamic model catalog for the webview selector. Never throws for
      // provider-side failures — the service reports source:'fallback' so the
      // webview can degrade to its built-in list. Emitted as a 'result'
      // envelope: {id, type:'result', data:{provider, models, source, error?}}.
      const result = await listModels('claude', { refresh: stdinData?.refresh === true });
      emit('result', result);
      break;
    }

    default:
      throw new Error(`Unknown Claude command: ${command}`);
  }
}

export function getClaudeCommandList() {
  return ['send', 'sendWithAttachments', 'getSession', 'getLatestUserMessage', 'rewindFiles', 'getMcpServerStatus', 'getMcpServerTools', 'resetRuntime', 'getContextUsage', 'listModels'];
}

registerChannel('claude', handleClaudeCommand, { sdk: CLAUDE_SDK_DESCRIPTOR });
