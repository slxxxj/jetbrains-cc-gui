import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const distFile = path.resolve(cwd, 'dist/index.html');
const distAssetsDir = path.resolve(cwd, 'dist/assets');
const targetFile = path.resolve(cwd, '../src/main/resources/html/claude-chat.html');
const targetAssetsDir = path.resolve(cwd, '../src/main/resources/html/assets');

// Prebuilt mermaid ESM bundle, imported at runtime by src/utils/mermaidChunk.ts
// through WebviewAssetSchemeHandler. The relative layout must be preserved:
// mermaid.esm.min.mjs references ./chunks/mermaid.esm.min/*.mjs, so everything
// under assets/mermaid/ resolves to a sibling URL on the same origin.
const mermaidDistDir = path.resolve(cwd, 'node_modules/mermaid/dist');
const mermaidTargetDir = path.join(targetAssetsDir, 'mermaid');

const copyMermaidBundle = async () => {
  await mkdir(path.join(mermaidTargetDir, 'chunks/mermaid.esm.min'), { recursive: true });
  await copyFile(
    path.join(mermaidDistDir, 'mermaid.esm.min.mjs'),
    path.join(mermaidTargetDir, 'mermaid.esm.min.mjs'),
  );
  const chunkDir = path.join(mermaidDistDir, 'chunks/mermaid.esm.min');
  const chunks = (await readdir(chunkDir)).filter((name) => name.endsWith('.mjs'));
  for (const chunk of chunks) {
    await copyFile(path.join(chunkDir, chunk), path.join(mermaidTargetDir, 'chunks/mermaid.esm.min', chunk));
  }
  console.log(`[copy-dist] 已同步 mermaid 预构建 bundle（${chunks.length + 1} 个文件）-> ${mermaidTargetDir}`);
};

const main = async () => {
  const html = await readFile(distFile, 'utf-8');
  await mkdir(path.dirname(targetFile), { recursive: true });
  await writeFile(targetFile, html, 'utf-8');
  console.log(`[copy-dist] 已同步 ${distFile} -> ${targetFile}`);

  // Sync lazy-loaded chunks (e.g. vconsole) that vite-plugin-singlefile
  // intentionally left out of the single-file html. They are served to JCEF
  // by WebviewAssetSchemeHandler from the /html/assets/ classpath resources.
  let entries;
  try {
    entries = await readdir(distAssetsDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      entries = null; // No separate chunks in this build; nothing to sync.
    } else {
      throw error;
    }
  }
  await rm(targetAssetsDir, { recursive: true, force: true });
  if (entries) {
    await mkdir(targetAssetsDir, { recursive: true });
    for (const entry of entries) {
      await copyFile(path.join(distAssetsDir, entry), path.join(targetAssetsDir, entry));
    }
    console.log(`[copy-dist] 已同步 ${entries.length} 个懒加载 chunk -> ${targetAssetsDir}`);
  }

  await copyMermaidBundle();
};

main().catch((error) => {
  console.error('[copy-dist] 复制构建产物失败', error);
  process.exit(1);
});
