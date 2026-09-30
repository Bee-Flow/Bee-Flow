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

/** Was this chat, an agent, or a routine? (activityLabels.js surfaceLabel.) */
export function surfaceLabel(row: SurfaceRow, t: TranslateFn): string {
    const src = (row.source ?? '').toLowerCase();
    const named = (base: string) => (row.agentName ? `${base} — ${row.agentName}` : base);
    if (row.automationId || src === 'routine') return named(t('admin.shield_activity_src_routine', 'Routine'));
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
