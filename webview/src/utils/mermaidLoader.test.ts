import { beforeEach, describe, expect, it, vi } from 'vitest';

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string) => ({ svg: `<svg data-id="${id}"></svg>` })),
  failNextImport: false,
}));

vi.mock('./mermaidChunk', () => ({
  importMermaidChunk: () => {
    if (mermaidMocks.failNextImport) {
      mermaidMocks.failNextImport = false;
      return Promise.reject(new Error('chunk load failed'));
    }
    return Promise.resolve({
      default: {
        initialize: mermaidMocks.initialize,
        render: mermaidMocks.render,
      },
    });
  },
}));

describe('loadMermaid', () => {
  beforeEach(() => {
    vi.resetModules();
    mermaidMocks.initialize.mockClear();
    mermaidMocks.render.mockClear();
    mermaidMocks.failNextImport = false;
  });

  it('imports the chunk lazily and initializes it exactly once across concurrent calls', async () => {
    const { loadMermaid } = await import('./mermaidLoader');

    const [first, second] = await Promise.all([loadMermaid(), loadMermaid()]);

    expect(first).toBe(second);
    expect(mermaidMocks.initialize).toHaveBeenCalledTimes(1);
    expect(mermaidMocks.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      fontFamily: 'inherit',
    });
  });

  it('does not cache a failed load, so a later call retries the import', async () => {
    const { loadMermaid } = await import('./mermaidLoader');

    mermaidMocks.failNextImport = true;
    await expect(loadMermaid()).rejects.toThrow('chunk load failed');

    // Retry without resetting module state: the same loader must re-import.
    await expect(loadMermaid()).resolves.toBeDefined();
    expect(mermaidMocks.initialize).toHaveBeenCalledTimes(1);
  });
});
