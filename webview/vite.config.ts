import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Lazy-loaded code is NOT inlined into dist/index.html; it is served to JCEF
// by WebviewAssetSchemeHandler (Java side) under this absolute origin, which
// must stay in sync with WebviewAssetSchemeHandler.ORIGIN. An absolute URL is
// required because the page itself is loaded via JBCefBrowser.loadHTML() under
// a file:///jbcefbrowser/... URL, so a relative chunk URL would resolve to a
// non-existent file:// path.
//
// Today the only such lazy chunk is vconsole (dev flag VITE_ENABLE_VCONSOLE);
// mermaid bypasses the vite graph entirely (prebuilt bundle imported via a
// @vite-ignore runtime URL, see src/utils/mermaidChunk.ts).
const WEBVIEW_ASSET_ORIGIN = 'https://codeaide-webview.invalid';

// Rollup always emits dynamic import() specifiers relative to the importing
// chunk ("./chunk.js"), and Vite's renderBuiltUrl hook does not cover them.
// That works for chunk-to-chunk imports once the first chunk loads over https,
// but the entry chunk is inlined into the html, where "./" would resolve
// against the file:///jbcefbrowser/... document URL. Rewrite all dynamic
// import specifiers to absolute scheme-handler URLs (all chunks are emitted
// flat into assets/, so "./x.js" always means "assets/x.js").
const absoluteLazyChunkUrls = (): Plugin => ({
  name: 'absolute-lazy-chunk-urls',
  enforce: 'post',
  generateBundle(_options, bundle) {
    for (const item of Object.values(bundle)) {
      if (item.type === 'chunk' && item.code.includes('import("./')) {
        item.code = item.code.replaceAll(
          'import("./',
          `import("${WEBVIEW_ASSET_ORIGIN}/assets/`,
        );
      }
    }
  },
});

export default defineConfig(({ command }) => ({
  // Full-URL base (build only, so the dev server keeps working) so
  // modulepreload dependency URLs point at the scheme-handler origin instead
  // of the file:// document URL. The entry script and stylesheet are inlined
  // into the html by vite-plugin-singlefile regardless of base, so only the
  // lazy chunk machinery is affected.
  base: command === 'build' ? `${WEBVIEW_ASSET_ORIGIN}/` : '/',
  plugins: [
    react(),
    absoluteLazyChunkUrls(),
    viteSingleFile({
      // Keep the recommended build config off: it forces
      // inlineDynamicImports=true, which would silently merge any lazy
      // chunk back into the entry and defeat the lazy loading.
      useRecommendedBuildConfig: false,
      // Inline only the entry chunk and the single CSS file; leave dynamic
      // chunks (vconsole) as separate files in dist/assets/.
      inlinePattern: ['assets/index-*.js', 'assets/*.css'],
    }),
  ],
  esbuild: {
    drop: ['debugger'],
    keepNames: true,
  },
  build: {
    minify: 'esbuild',
    assetsInlineLimit: 1024 * 1024,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
}));
