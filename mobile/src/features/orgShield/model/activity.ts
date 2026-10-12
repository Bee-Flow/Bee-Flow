/**
 * Plain words and small roll-ups for the "What happened" tab — the web's
 * activity/activityLabels.js, and the country list that replaces its world
 * map on a phone. Label tables carry the key and its English together, so
 * they cannot drift apart and the i18n guard can see they are translated.
 */

import type { TranslateFn } from '@/core/i18n';

import { categoryDef } from './piiCatalog';

interface Label {
    key: string;
    en: string;
}

export const MARKERS: Readonly<Record<string, Label>> = {
    privacy_protection_unavailable: { key: 'admin.shield_activity_marker_privacy_protection_unavailable', en: 'Protection was unavailable' },
    scan_timeout: { key: 'admin.shield_activity_marker_scan_timeout', en: 'Check ran out of time' },
    scan_overflow: { key: 'admin.shield_activity_marker_scan_overflow', en: 'File too large to fully check' },
    scan_degraded: { key: 'admin.shield_activity_marker_scan_degraded', en: 'Check ran reduced' },
    token_evicted: { key: 'admin.shield_activity_marker_token_evicted', en: 'Some placeholders were dropped' },
};

export const ACTIONS: Readonly<Record<string, Label>> = {
    blocked: { key: 'admin.shield_activity_action_blocked', en: 'Stopped' },
    redacted: { key: 'admin.shield_activity_action_redacted', en: 'Hidden' },
    allowed: { key: 'admin.shield_activity_action_allowed', en: 'Sent anyway' },
    tokenized: { key: 'admin.shield_activity_action_tokenized', en: 'Placeholders' },
    search_blocked: { key: 'admin.shield_activity_action_search_blocked', en: 'Search stopped' },
    pii_detected: { key: 'admin.shield_activity_action_pii_detected', en: 'Noted only' },
    passed_unredacted: { key: 'admin.shield_activity_action_passed_unredacted', en: 'Sent unchecked' },
    scan_failed: { key: 'admin.shield_activity_action_scan_failed', en: 'Check failed' },
};

/** Unknown values pass through: a row written by a future release stays readable. */
export function actionLabel(action: string | null | undefined, t: TranslateFn): string {
    if (!action) return '—';
    const entry = ACTIONS[action];
    return entry ? t(entry.key, entry.en) : action;
}

/** One stored category id, audit marker or legacy label → words. */
export function categoryLabel(id: string, t: TranslateFn): string {
    const def = categoryDef(id);
    if (def) return t(def.i18nKey, def.fallback);
    const marker = MARKERS[id];
    return marker ? t(marker.key, marker.en) : id;
}

// ── Special categories (GDPR Art. 9): health is an organisation total only ──
// A health label next to a person reveals health data about that person, so
// the server shows health categories only as organisation totals
// (server/core/privacy/specialCategories.js): it strips them from every row
// that carries a user, and answers `?pii=<health category>` next to a person
// with 400 `special_category_per_person`. The phone never filters at all, and
// applies the same row rule itself (api/endpoints.ts), so a server from
// before that change cannot put a health label beside a name either. The
// web's list is activity/specialCategories.ts; activity.lockstep.test.ts pins
// both against the server.

/** Every spelling of a health category, squashed to bare lower-case letters and digits. */
export const SPECIAL_CATEGORY_SPELLINGS: readonly string[] = Object.freeze([
    // The canonical ids (personalColumns KIND_OF_CATEGORY → 'health').
    'healthinsurancenumber',
    'medicalcondition',
    'medication',
    // The older spellings producers wrote (personalColumns LOOSE_KIND → 'health').
    'health',
    'medical',
]);

const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Is this stored category, in any spelling, a special category (health)? */
export function isSpecialCategory(category: string | null | undefined): boolean {
    if (category === null || category === undefined) return false;
    const squashed = squash(category);
    return squashed !== '' && SPECIAL_CATEGORY_SPELLINGS.includes(squashed);
}

const entriesOf = (list: string): string[] => list.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Rows that carry a person, without health labels in `field` — the server's
 * `withholdSpecialCategories`. A row whose list named ONLY health is left out:
 * kept with an empty list it would stand out (a find without a kind) and so
 * say what was removed. Rows are copied, never changed in place.
 */
export function withholdSpecialCategories<T, K extends keyof T>(rows: readonly T[], field: K): T[] {
    const out: T[] = [];
    for (const row of rows) {
        const value = row[field];
        const entries = typeof value === 'string' ? entriesOf(value) : [];
        if (!entries.some(isSpecialCategory)) {
            out.push(row);
            continue;
        }
        const kept = entries.filter((e) => !isSpecialCategory(e));
        if (kept.length > 0) out.push({ ...row, [field]: kept.join(',') });
    }
    return out;
}

/** The note beside the totals when they name a health category (the web's kinds card says the same). */
export const SPECIAL_TOTAL_NOTE: Readonly<Label> = {
    key: 'shield_activity.special_category_total_only',
    en: 'Health data is shown as an organisation total only, never per person.',
};

/** The window's totals name a health category: the summary says it is a total only. */
export function namesSpecialCategory(counts: readonly { category: string; count: number }[]): boolean {
    return counts.some((c) => c.count > 0 && isSpecialCategory(c.category));
}

/** A comma-joined column → labels, de-duplicated (legacy rows repeat a label per hit). */
export function categoriesLabel(value: string | null | undefined, t: TranslateFn): string {
    if (!value) return '';
    const parts = [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
    return parts.map((id) => categoryLabel(id, t)).join(', ');
}

export interface SurfaceRow {
    source: string | null;
    automationId: string | null;
    agentId: string | null;
    agentName: string | null;
}

/** Was this chat, an agent, or an automation? (activityLabels.js surfaceLabel.) */
export function surfaceLabel(row: SurfaceRow, t: TranslateFn): string {
    const src = (row.source ?? '').toLowerCase();
    const named = (base: string) => (row.agentName ? `${base} — ${row.agentName}` : base);
    if (row.automationId || src === 'automation') return named(t('admin.shield_activity_src_automation', 'Automation'));
    if (src.startsWith('agent') || (row.agentId && !src.startsWith('direct'))) {
        return named(t('admin.shield_activity_src_agent', 'Agent'));
    }
    if (src.startsWith('direct')) return t('admin.shield_activity_src_direct', 'Direct chat');
    if (src.includes('notebook')) return t('admin.shield_activity_src_notebook', 'Notebook');
    return row.agentName || row.source || '—';
}

export interface DestinationRow {
    country_code: string | null;
    country_name: string | null;
    is_eu: boolean;
    is_local: boolean;
    total: number;
    pii_events: number;
}

export interface CountryRow {
    code: string;
    name: string;
    isEu: boolean;
    isLocal: boolean;
    total: number;
    piiEvents: number;
}

/** The world map's data as a list: destinations folded per country, busiest first. */
export function countriesOf(destinations: readonly DestinationRow[]): CountryRow[] {
    const byCode = new Map<string, CountryRow>();
    for (const d of destinations) {
        const code = d.is_local ? 'local' : (d.country_code ?? '??');
        const row = byCode.get(code) ?? {
            code,
            name: d.country_name ?? code,
            isEu: d.is_eu,
            isLocal: d.is_local,
            total: 0,
            piiEvents: 0,
        };
        row.total += d.total;
        row.piiEvents += d.pii_events;
        byCode.set(code, row);
    }
    return [...byCode.values()].sort((a, b) => b.total - a.total);
}
