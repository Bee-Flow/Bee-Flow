/**
 * actions — where a click in the Compliance Center goes (redesign, Sep 2026).
 *
 * The hub emits `admin/compliance/<section>[/<id>]` — the shape
 * `pages/settings/complianceNavAdapter.js` rewrites for the settings URL and
 * `ComplianceHub.nav.test.jsx` pins. Everything that produces such a path is
 * here so the rail, the header, the attention list and the deadline rows
 * cannot disagree.
 *
 * NOT `Studio/attention/attentionLink.js`: that one refuses any deep link that
 * does not start with `/app/studio/` (the Studio attention pipe must never
 * hand the router a foreign path). Compliance lives under
 * `/app/settings/organisation/compliance/…`, so it keeps its own resolver
 * and the two stay separate on purpose.
 */
import { useCallback, useState } from 'react';
import { resolveSection, sectionForRegulation } from '../sections';

/** `admin/compliance/<canonical>[/<encoded id>]`. */
export function compliancePath(sectionId, subId = null) {
    const id = resolveSection(sectionId);
    return subId != null && subId !== '' ? `admin/compliance/${id}/${encodeURIComponent(String(subId))}` : `admin/compliance/${id}`;
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

/** The compliance section a remediation link lands in, or null when it leaves the hub. */
export function sectionOfPath(path) {
    const m = /^admin\/compliance(?:\/([^/]+))?/.exec(path || '');
    return m ? resolveSection(m[1]) : null;
}

/**
 * `?tab=<id>` on the current URL — read once, written with replaceState so a
 * tab switch never adds a history entry. The demo host has no query string
 * to speak of; the default (first tab) wins there.
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
    return [value, set];
}
