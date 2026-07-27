/**
 * User-defined quick prompts, persisted in localStorage.
 *
 * Built-in presets (quickPrompts.ts) are read-only; users can additionally
 * save their own frequently used instructions from the current input box
 * content and delete them later. Storage failures (e.g. restricted JCEF
 * contexts) degrade gracefully to an in-memory-only list for the session.
 */

export interface CustomQuickPrompt {
  id: string;
  text: string;
  createdAt: number;
}

export const CUSTOM_QUICK_PROMPTS_KEY = 'codeaide.quickPrompts.custom';

function readStorage(): CustomQuickPrompt[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_QUICK_PROMPTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is CustomQuickPrompt =>
        typeof item === 'object' && item !== null &&
        typeof (item as CustomQuickPrompt).id === 'string' &&
        typeof (item as CustomQuickPrompt).text === 'string' &&
        (item as CustomQuickPrompt).text.trim().length > 0,
    );
  } catch {
    return [];
  }
}

function writeStorage(prompts: CustomQuickPrompt[]): void {
  try {
    window.localStorage.setItem(CUSTOM_QUICK_PROMPTS_KEY, JSON.stringify(prompts));
  } catch {
    // Ignore storage failures; the in-memory state still updates.
  }
}

export function loadCustomQuickPrompts(): CustomQuickPrompt[] {
  return readStorage();
}

/**
 * Save a new custom prompt. Empty/whitespace-only text and exact duplicates
 * are ignored. Returns the full updated list.
 */
export function saveCustomQuickPrompt(text: string): CustomQuickPrompt[] {
  const trimmed = text.trim();
  const existing = readStorage();
  if (!trimmed || existing.some(p => p.text === trimmed)) {
    return existing;
  }
  const entry: CustomQuickPrompt = {
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: trimmed,
    createdAt: Date.now(),
  };
  const next = [entry, ...existing];
  writeStorage(next);
  return next;
}

/** Remove a custom prompt by id. Returns the full updated list. */
export function removeCustomQuickPrompt(id: string): CustomQuickPrompt[] {
  const next = readStorage().filter(p => p.id !== id);
  writeStorage(next);
  return next;
}

/** Short display label for a custom prompt: first line, truncated. */
export function customQuickPromptLabel(text: string, maxLength = 24): string {
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength)}…` : firstLine;
}
