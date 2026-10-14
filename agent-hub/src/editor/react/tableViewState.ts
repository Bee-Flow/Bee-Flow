/**
 * Collapse persistence (view-only; never serialized): which tables are folded
 * and which hide their column-name strip, per notebook, in localStorage.
 */
export function loadCollapsed(notebookId: string | number | null | undefined): Set<number> {
  try { return new Set(JSON.parse(localStorage.getItem(`bf.table.collapsed.${notebookId || 'doc'}`) || '[]')); }
  catch (e) { return new Set(); }
}
export function saveCollapsed(notebookId: string | number | null | undefined, set: Set<number>): void {
  try { localStorage.setItem(`bf.table.collapsed.${notebookId || 'doc'}`, JSON.stringify([...set])); }
  catch { /* noop */ }
}
export function loadHiddenHeaders(notebookId: string | number | null | undefined): Set<number> {
  try { return new Set(JSON.parse(localStorage.getItem(`bf.table.noheaders.${notebookId || 'doc'}`) || '[]')); }
  catch (e) { return new Set(); }
}
export function saveHiddenHeaders(notebookId: string | number | null | undefined, set: Set<number>): void {
  try { localStorage.setItem(`bf.table.noheaders.${notebookId || 'doc'}`, JSON.stringify([...set])); }
  catch { /* noop */ }
}
