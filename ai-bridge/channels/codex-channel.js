/**
 * Codex channel command handler – keeps Codex specific logic separated.
 *
 * Codex runs per-process in both dispatch modes; the dispatch context is
 * accepted for registry signature compatibility but does not alter behavior.
 */
import { sendMessage as codexSendMessage } from '../services/codex/message-service.js';
import { getMcpServerTools as codexGetMcpServerTools } from '../services/codex/message-service.js';
import { listModels } from '../services/model-list-service.js';
import { emit } from '../protocol/emitter.js';
import { registerChannel } from './registry.js';
import { CODEX_SDK_DESCRIPTOR } from './sdk-descriptors.js';

/**
 * Execute a Codex command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 * @param {object} [context] dispatch context ({ isDaemonMode }); unused today
 *   because Codex has no persistent runtime
 */
export async function handleCodexCommand(command, args, stdinData, context) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const {
          message,
          threadId,
          cwd,
          permissionMode,
          model,
          baseUrl,
          apiKey,
          reasoningEffort,
          serviceTier,
          attachments  // Image attachments (local_image format)
        } = stdinData;
        await codexSendMessage(
          message,
          threadId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          baseUrl || '',
          apiKey || '',
          (reasoningEffort === 'max' ? 'xhigh' : (reasoningEffort || 'medium')),
          serviceTier || '',
          attachments || []  // Pass attachments to message service
        );
      } else {
        await codexSendMessage(args[0], args[1], args[2], args[3], args[4]);
      }
      break;
    }

    case 'getMcpServerTools': {
      const serverId = stdinData?.serverId || args[0] || null;
      const serverConfig = stdinData?.serverConfig || null;
      await codexGetMcpServerTools(serverId, serverConfig);
      break;
    }

    case 'listModels': {
      // Dynamic model catalog via the vendored CLI's `debug models`. Never
      // throws for CLI failures — the service reports source:'fallback' so the
      // webview can degrade to its built-in list. Emitted as a 'result'
      // envelope: {id, type:'result', data:{provider, models, source, error?}}.
      const result = await listModels('codex', { refresh: stdinData?.refresh === true });
      emit('result', result);
      break;
    }

    default:
      throw new Error(`Unknown Codex command: ${command}`);
  }
}

export function getCodexCommandList() {
  return ['send', 'getMcpServerTools', 'listModels'];
}

registerChannel('codex', handleCodexCommand, { sdk: CODEX_SDK_DESCRIPTOR });
