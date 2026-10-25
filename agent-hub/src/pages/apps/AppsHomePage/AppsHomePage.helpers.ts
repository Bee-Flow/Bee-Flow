import type { DirectoryApp } from '../AppsHomePage.types';
import { DEFAULT_ACCENT, APP_CATEGORIES, NEW_FOR_MS } from './AppsHomePage.constants';

// The app's own accent at 16% — the tint the card tiles carry across Studio.
// color-mix rather than an `${hex}29` suffix so the recipe reads as a
// percentage and survives a non-hex accent unchanged.
export function accentTile(accentColor: string | undefined) {
    const accent = /^#[0-9a-fA-F]{6}$/.test(accentColor || '') ? accentColor : DEFAULT_ACCENT;
    return { background: `color-mix(in srgb, ${accent} 16%, transparent)`, color: accent };
}

/** The app's category when it is one of the closed list, else null. */
export function appCategory(app: DirectoryApp | null | undefined) {
    const raw = app?.category;
    if (typeof raw !== 'string') return null;
    const key = raw.trim().toLowerCase();
    return APP_CATEGORIES.includes(key) ? key : null;
}

/**
 * The closed-list categories at least one app in view carries, in the LIST's
 * own order — so the row never reshuffles itself between two loads.
 */
export function categoriesInView(apps: DirectoryApp[]) {
    return APP_CATEGORIES.filter((c) => apps.some((a) => appCategory(a) === c));
}

/** The apps under a chip; 'all' (and any stale selection) shows everything. */
export function visibleUnder(apps: DirectoryApp[], category: string) {
    return category === 'all' ? apps : apps.filter((a) => appCategory(a) === category);
}

// ── Search ──────────────────────────────────────────────────────────
// Twenty tools is past the point where scanning the grid works, and the
// browser's own ctrl-F only finds what is already painted. The filter runs
// over the list the page ALREADY holds — the directory is org-sized, not
// install-sized, so there is nothing to ask the server for.
//
// Name and description both, because half the apps in a real directory are
// named after the department that ordered them ("Bakker-tool") and the
// description is the only place the word "invoice" appears.
export function matchesQuery(app: DirectoryApp | null | undefined, query: string) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return true;
    const haystack = `${app?.name || ''} ${app?.description || ''}`.toLowerCase();
    return haystack.includes(q);
}

export function isNewlyPublished(app: DirectoryApp | null | undefined, now: number = Date.now()) {
    const at = Date.parse(app?.publishedAt || '');
    if (!Number.isFinite(at)) return false;
    // A future stamp (clock skew, a seeded fixture) is not "new" — it is
    // wrong, and a badge is not the place to argue about it.
    return at <= now && now - at < NEW_FOR_MS;
}

/**
 * Directory order: by NAME.
 *
 * It used to be `updatedAt` — "last touched by whoever built it", which for a
 * reader is noise: an app moves to the front because someone fixed a label in
 * it. The design asks for "most used", but this product has no honest usage
 * number yet (the only run log counts action runs and misses whole categories
 * of app), and a line that names a sort the data cannot support is worse than
 * a plain one. Name it is — the same order the sidebar's Studio flyout
 * already uses, so two surfaces stop answering the question two ways, and the
 * one order a reader can predict well enough to aim at.
 */
export function byName(a: DirectoryApp, b: DirectoryApp) {
    return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, {
        numeric: true, sensitivity: 'base',
    });
}

export const isPublished = (a: DirectoryApp | null | undefined) => !!(a?.isPublished ?? a?.is_published);
