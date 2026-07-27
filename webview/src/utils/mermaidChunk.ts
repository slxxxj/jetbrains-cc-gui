/**
 * Dynamic import of the prebuilt mermaid ESM bundle.
 *
 * The bundle (node_modules/mermaid/dist/mermaid.esm.min.mjs plus its
 * ./chunks/mermaid.esm.min/ tree) is copied verbatim into
 * src/main/resources/html/assets/mermaid/ by webview/scripts/copy-dist.mjs
 * and served to JCEF by WebviewAssetSchemeHandler under the origin below.
 *
 * Kept in a separate module for two reasons:
 * - the specifier must stay an unanalyzable runtime URL (@vite-ignore) so the
 *   vite build neither resolves nor bundles mermaid, keeping it out of the
 *   single-file entry;
 * - vitest cannot resolve https: URLs, so tests mock this module instead of
 *   the 'mermaid' package.
 */

export type MermaidApi = (typeof import('mermaid'))['default'];

export type MermaidModule = { default: MermaidApi };

// Typed as string (not a literal) so TypeScript does not try to resolve it.
const MERMAID_MODULE_URL: string =
  'https://codeaide-webview.invalid/assets/mermaid/mermaid.esm.min.mjs';

export function importMermaidChunk(): Promise<MermaidModule> {
  return import(/* @vite-ignore */ MERMAID_MODULE_URL) as Promise<MermaidModule>;
}
