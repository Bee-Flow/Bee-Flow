/**
 * actions — where a click in the Compliance Center goes (redesign, Sep 2026).
 *
 * The hub emits `admin/compliance/<section>[/<id>][?tab=<tab>]` — the shape
 * `pages/settings/complianceNavAdapter.js` rewrites for the settings URL and
 * `ComplianceHub.nav.test.jsx` pins. Everything that produces or reads such a
 * path is here so the rail, the header, the attention list and the deadline
 * rows cannot disagree. The tab travels IN the path: a host that pushes a new
 * URL (Settings) would otherwise drop it, because the hub re-reads `?tab=` on
 * every pathname change.
 *
 * NOT `Studio/attention/attentionLink.js`: that one refuses any deep link that
 * does not start with `/app/studio/` (the Studio attention pipe must never
 * hand the router a foreign path). Compliance lives under
 * `/app/settings/organisation/compliance/…`, so it keeps its own resolver
 * and the two stay separate on purpose.
 */
import { useCallback, useState } from 'react';
import { resolveSection, resolveTab, sectionForRegulation } from '../sections';

/** `admin/compliance/<canonical>[/<encoded id>][?tab=<tab>]`. */
export function compliancePath(sectionId, subId = null, tab = null) {
    const id = resolveSection(sectionId);
    const base = subId != null && subId !== '' ? `admin/compliance/${id}/${encodeURIComponent(String(subId))}` : `admin/compliance/${id}`;
    return tab ? `${base}?tab=${encodeURIComponent(String(tab))}` : base;
}

/** The section that scores a check row (by regulation), for deep links into the checks table. */
export function checkPath(check) {
    return compliancePath(sectionForRegulation(check?.regulation), check?.check_id);
}

/**
 * A server-side attention `action` → the path onNavigate receives.
 *   { type:'navigate', target:'/app/admin/compliance/ropa' }  → 'admin/compliance/ropa'
 *   { type:'open_fix', target:'admin/security/guardrails' }   → 'admin/security/guardrails' (an admin escape the adapter maps)
 *   { type:'auto_fix' }                                        → null (the caller runs core.autoFix instead)
 * A check's `remediationLink` follows the same rules.
 */
export function complianceActionPath(action) {
    if (!action) return null;
    if (action.type === 'auto_fix') return null;
    const target = typeof action === 'string' ? action : action.target;
    if (!target || typeof target !== 'string') return null;
    let p = target.trim();
    if (/^https?:\/\//i.test(p)) return null; // never hand the SPA router an absolute URL
    p = p.replace(/^\/?app\//, '').replace(/^\//, '');
    if (p.startsWith('settings/organisation/compliance/')) p = 'admin/compliance/' + p.slice('settings/organisation/compliance/'.length);
    if (p === 'settings/organisation/compliance') p = 'admin/compliance/overview';
    return p || null;
}

/** The compliance section a remediation link lands in, or null when it leaves the hub. The query is never part of it. */
export function sectionOfPath(path) {
    const m = /^admin\/compliance(?:\/([^/?#]+))?(?:[/?#]|$)/.exec(path || '');
    return m ? resolveSection(m[1]) : null;
}

/** The `?tab=` value of a hub path, or null. */
export function tabOfPath(path) {
    const query = /\?([^#]*)/.exec(String(path || ''))?.[1];
    if (!query) return null;
    try { return new URLSearchParams(query).get('tab') || null; } catch { return null; }
}

/**
 * A hub path → `{ section, id, tab }` for `navigate(section, id, tab)`, or
 * null when the path leaves the hub. A tab that moved to another section
 * (`sections.js` legacyTabs) lands there: `audits?tab=obligations` →
 * `{ section: 'training' }`. The id belongs to the original section, so a
 * moved tab drops it.
 */
export function resolveTarget(path) {
    const section = sectionOfPath(path);
    if (!section) return null;
    const raw = /^admin\/compliance\/[^/?#]+\/([^?#]+)/.exec(path)?.[1];
    let id;
    if (raw) { try { id = decodeURIComponent(raw); } catch { id = raw; } }
    const to = resolveTab(section, tabOfPath(path));
    return { section: to.section, id: to.section === section ? id : undefined, tab: to.tab || undefined };
}

/**
 * `?tab=<id>` on the current URL — read once, written with replaceState so a
 * tab switch never adds a history entry. The demo host has no query string
 * to speak of; the default (first tab) wins there.
 *
 * Returns `[value, set, setLocal]`. `setLocal` changes the state only, for a
 * navigation whose host writes the new URL itself (the path carries the tab):
 * writing it onto the CURRENT URL first would leave the old history entry
 * with the next page's tab.
 */
function readQueryParam(name, fallback) {
    if (typeof window === 'undefined') return fallback;
    try { return new URLSearchParams(window.location.search).get(name) || fallback; }
    catch { return fallback; }
}

export function useUrlQueryParam(name, fallback = null) {
    const [value, setValue] = useState(() => readQueryParam(name, fallback));
    // A route change re-reads the param — during render, keyed on the path.
    const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
    const [seenPath, setSeenPath] = useState(pathname);
    if (seenPath !== pathname) {
        setSeenPath(pathname);
        setValue(readQueryParam(name, fallback));
    }
    const set = useCallback((next) => {
        setValue(next || fallback);
        if (typeof window === 'undefined') return;
        try {
            const url = new URL(window.location.href);
            if (next && next !== fallback) url.searchParams.set(name, next); else url.searchParams.delete(name);
            window.history.replaceState(window.history.state, '', url.toString());
        } catch { /* a host without a real URL (tests, demo) keeps the state only */ }
    }, [name, fallback]);
    const setLocal = useCallback((next) => { setValue(next || fallback); }, [fallback]);
    return [value, set, setLocal];
}
