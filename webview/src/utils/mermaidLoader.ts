import { importMermaidChunk, type MermaidApi } from './mermaidChunk';

/**
 * Lazy loader for the mermaid library.
 *
 * Mermaid is ~3 MB minified, so it is kept out of the single-file entry
 * bundle and only fetched (from WebviewAssetSchemeHandler on the Java side)
 * the first time a diagram is rendered.
 */

let mermaidPromise: Promise<MermaidApi> | null = null;

/**
 * Load mermaid on demand. The promise is cached so the module is fetched and
 * initialized at most once; a failed load is not cached so a later render
 * can retry (e.g. after a transient chunk-serving failure).
 */
export function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = importMermaidChunk()
      .then((mod) => {
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict',
          fontFamily: 'inherit',
        });
        return mermaid;
      })
      .catch((error: unknown) => {
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}
