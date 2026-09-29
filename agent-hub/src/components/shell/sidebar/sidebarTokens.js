import scopedStorage from '../../../utils/scopedStorage';

/* ─── Design tokens ─── */
export const ROW = 'w-full flex items-center gap-2.5 px-3 h-9 rounded-lg transition-all duration-150 text-left relative';
export const ROW_ACTIVE = 'bg-[var(--item-active-bg)]';
export const ROW_IDLE = 'hover:bg-[var(--item-hover-bg)]';
export const ACCENT_BAR = 'absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-[var(--accent-primary)]';
export const SECTION_HDR = 'flex items-center justify-between px-3 h-9 cursor-pointer select-none';
// Uppercase micro-heading — same voice as the marketing header's mega-menu
// column headings (BUILD / WORK).
export const SECTION_LBL = 'text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]';
export const CONV_ROW = 'w-full flex items-center px-4 py-1 text-left relative cursor-pointer gap-1.5';
export const ICON_ACTIVE = 'text-[var(--accent-primary)]';
export const ICON_IDLE = 'text-[var(--text-tertiary)]';
export const TEXT_ACTIVE = 'font-bold text-[var(--text-primary)]';
export const TEXT_IDLE = 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors';
export const ACCENT_BAR_CONV = 'absolute left-0 top-0 bottom-0 w-[3px] bg-gray-400 rounded-r-sm';

/* How long a Studio section's item list stays fresh. Short, because the things
   that invalidate it (rename, create, delete) all happen inside Studio — the
   one place you never navigate away from before reaching for this menu. */
export const SECTION_TTL_MS = 60_000;

/* ─── Scoped-storage helpers for sidebar collapse state (per-user).

   Section keys ('agents', 'chats', 'projects') are part of the browser-state
   contract: the storageMigrations v1 pass moves their pre-scoping bare forms
   into the user scope, so a saved collapse choice survives the upgrade. If a
   redesign ever gives a group a new meaning, give it a NEW key and retire
   the old one via a new storageMigrations version step ("new meaning = new
   name") — reusing the old slot would let a stored '0' from the previous
   era silently start the new group collapsed. */
const storageKey = (k) => `sidebar_${k}_expanded`;
export const readExpanded = (k, fallback) => {
    const v = scopedStorage.getItem(storageKey(k));
    // Allow-list the two values writeExpanded produces; junk (a hand-edited
    // or truncated entry) falls back to the section's default instead of
    // silently reading as "collapsed".
    if (v === '1') return true;
    if (v === '0') return false;
    return fallback;
};
export const writeExpanded = (k, v) => {
    scopedStorage.setItem(storageKey(k), v ? '1' : '0');
};

/* ─── Remembered "is there anything behind this row?" answers ───
   Apps, Forms and Approvals are listed only when the person actually has
   something there, and that answer comes from the server a moment after the
   sidebar first paints. Remembering the last one per user keeps the menu from
   reshuffling on every load: the row renders in the shape it had when they
   last looked, and the fetch only corrects it when the answer really changed.
   An unknown answer (a first-ever load, a cleared browser) reads as "nothing":
   a row that appears a moment later is a far smaller surprise than one that
   vanishes from under the cursor. A failed request never writes, so the last
   good answer survives an offline moment instead of emptying the menu. */
const navHasKey = (k) => `sidebar_has_${k}`;
export const readNavHas = (k) => scopedStorage.getItem(navHasKey(k)) === '1';
export const writeNavHas = (k, v) => {
    scopedStorage.setItem(navHasKey(k), v ? '1' : '0');
};

/* ─── Published-app icon colour — the app's accent (validated hex), same
   default as AppList / AppsHomePage. No tile behind it, just the glyph. */
const APP_DEFAULT_ACCENT = '#0F766E';
export const appAccent = (accentColor) => (/^#[0-9a-fA-F]{6}$/.test(accentColor || '') ? accentColor : APP_DEFAULT_ACCENT);
