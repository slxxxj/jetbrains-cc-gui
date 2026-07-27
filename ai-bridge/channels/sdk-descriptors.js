/**
 * SDK descriptors declared by the built-in channels.
 *
 * Pure data module (no imports) so every consumer — channel self-registration
 * and low-level sdk-loader alike — resolves the same descriptor regardless of
 * module load order. ids/npmPackages are kept in sync with
 * DependencyManager.SdkDefinition on the Java side.
 *
 * To add a provider, add its descriptor here and create its channel file.
 */

export const CLAUDE_SDK_DESCRIPTOR = {
  id: 'claude-sdk',
  npmPackage: '@anthropic-ai/claude-agent-sdk',
  cacheKey: 'claude',
  displayName: 'Claude SDK',
  notInstalledMessage: 'Claude Code SDK not installed. Please install via Settings > Dependencies.'
};

export const CODEX_SDK_DESCRIPTOR = {
  id: 'codex-sdk',
  npmPackage: '@openai/codex-sdk',
  cacheKey: 'codex',
  displayName: 'Codex SDK',
  notInstalledMessage: 'Codex SDK not installed. Please install via Settings > Dependencies.'
};

export const CHANNEL_SDK_DESCRIPTORS = {
  claude: CLAUDE_SDK_DESCRIPTOR,
  codex: CODEX_SDK_DESCRIPTOR
};
