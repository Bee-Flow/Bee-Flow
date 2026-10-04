/**
 * Plain words for the values the activity endpoints store.
 *
 * Extracted from the old `ActivityDetailTable` when the "What happened" pane
 * became one cross-filter and grew its own table: the label rules are shared
 * by the table, the filter chips, the top-5 lists and the map legend, and they
 * had no business living inside one of those consumers.
 *
 * ── The `{ key, en }` shape ───────────────────────────────────────────────
 * Each table pairs the stored value with BOTH its dictionary key and its
 * English, rather than holding English that some caller elsewhere remembers to
 * pass as a `t()` fallback. Two reasons, and the second is the real one:
 *
 *  1. The key and the words it defaults to are read together, so they cannot
 *     drift apart in a review.
 *  2. A bare table of English is indistinguishable, to any tool and to any
 *     reader, from a table that is never translated at all. That is precisely
 *     the shape `i18nGuard` exists to catch, and it has caught it here before
 *     in eight other modules. Putting the key inside the table is the fix it
 *     is asking for rather than a way around it.
 *
 * An UNKNOWN value passes through untranslated rather than becoming "—": a row
 * written by a future release must stay readable.
 */

import { useMemo } from 'react';

import { piiCategoriesLocalized } from '../../../../../../config/piiCategories';

/**
 * Audit markers that travel in the categories column but are not categories.
 * They are worth showing and filtering by — "what went out while the scanner
 * was down" is a real question — so they are labelled, not hidden.
 */
export const MARKERS = {
    privacy_protection_unavailable: { key: 'admin.shield_activity_marker_privacy_protection_unavailable', en: 'Protection was unavailable' },
    scan_timeout: { key: 'admin.shield_activity_marker_scan_timeout', en: 'Check ran out of time' },
    scan_overflow: { key: 'admin.shield_activity_marker_scan_overflow', en: 'File too large to fully check' },
    scan_degraded: { key: 'admin.shield_activity_marker_scan_degraded', en: 'Check ran reduced' },
    // An automation hit the per-run placeholder ceiling, so the oldest placeholders
    // can no longer be turned back into real values.
    token_evicted: { key: 'admin.shield_activity_marker_token_evicted', en: 'Some placeholders were dropped' },
    // The chat's pre-send check could not run and the message went out
    // unchecked (a dlp_decision row); the word is the action's own.
    scan_failed: { key: 'admin.shield_activity_action_scan_failed', en: 'Check failed' },
};

/** Is this id an audit marker rather than a kind of personal data? */
export function isMarker(id) {
    return Object.prototype.hasOwnProperty.call(MARKERS, id);
}

/** What-we-did values → plain words. Unknown values pass through. */
export const ACTIONS = {
    blocked: { key: 'admin.shield_activity_action_blocked', en: 'Stopped' },
    redacted: { key: 'admin.shield_activity_action_redacted', en: 'Hidden' },
    allowed: { key: 'admin.shield_activity_action_allowed', en: 'Sent anyway' },
    tokenized: { key: 'admin.shield_activity_action_tokenized', en: 'Placeholders' },
    search_blocked: { key: 'admin.shield_activity_action_search_blocked', en: 'Search stopped' },
    pii_detected: { key: 'admin.shield_activity_action_pii_detected', en: 'Noted only' },
    passed_unredacted: { key: 'admin.shield_activity_action_passed_unredacted', en: 'Sent unchecked' },
    scan_failed: { key: 'admin.shield_activity_action_scan_failed', en: 'Check failed' },
    // Written by the tool gate, the attachment intake and the input gates.
    // Before these had words they showed as the raw stored value.
    tool_blocked: { key: 'shield_activity.action_tool_blocked', en: 'Tool call stopped' },
    tool_result_redacted: { key: 'shield_activity.action_tool_result_redacted', en: 'Hidden in a tool result' },
    partial_redacted: { key: 'shield_activity.action_partial_redacted', en: 'Partly replaced' },
    held: { key: 'shield_activity.action_held', en: 'File held back' },
    stripped: { key: 'shield_activity.action_stripped', en: 'Hidden characters removed' },
};

/**
 * The design's outcomes (outcomes.ts), long for the legend and the chips,
 * short for the log and the day tooltip.
 */
export const OUTCOME_WORDS = {
    replaced: { key: 'shield_activity.outcome_replaced', en: 'Replaced with placeholders' },
    stopped: { key: 'shield_activity.outcome_stopped', en: 'Stopped' },
    tool: { key: 'shield_activity.outcome_tool', en: 'Left with a tool, unchanged' },
    passed: { key: 'shield_activity.outcome_passed', en: 'Let through' },
    clean: { key: 'shield_activity.outcome_clean', en: 'No personal data' },
    unchecked: { key: 'shield_activity.outcome_unchecked', en: 'Not checked for personal data' },
    other: { key: 'shield_activity.outcome_other', en: 'Other' },
};

export const OUTCOME_SHORT_WORDS = {
    replaced: { key: 'shield_activity.outcome_short_replaced', en: 'Replaced' },
    stopped: { key: 'shield_activity.outcome_stopped', en: 'Stopped' },
    tool: { key: 'shield_activity.outcome_short_tool', en: 'Left unchanged' },
    passed: { key: 'shield_activity.outcome_passed', en: 'Let through' },
    clean: { key: 'shield_activity.outcome_clean', en: 'No personal data' },
    unchecked: { key: 'shield_activity.outcome_short_unchecked', en: 'Not checked' },
    other: { key: 'shield_activity.outcome_other', en: 'Other' },
};

/** Where a call went, as the region groups, the chips and the log name it. */
export const REGION_WORDS = {
    local: { key: 'admin.shield_activity_own_server_col', en: 'Your own server' },
    eu: { key: 'shield_activity.region_eu', en: 'Inside Europe (EEA)' },
    outside: { key: 'egress_map.legend_outside', en: 'Outside Europe' },
    via_network: { key: 'egress_map.legend_network', en: 'Via a global network' },
    unknown: { key: 'shield_activity.region_unknown', en: 'Location unknown' },
};

/** What an entry was. */
export const ENTRY_WORDS = {
    model: { key: 'admin.shield_activity_d_model', en: 'AI model' },
    tool: { key: 'shield_activity.type_tool', en: 'Tool' },
    web_search: { key: 'shield_activity.type_web_search', en: 'Web search' },
};

/** One of the tables above → its words; an unknown value passes through. */
export function wordFor(table, value, t) {
    const entry = table[value];
    return entry ? t(entry.key, entry.en) : String(value ?? '');
}

export function actionLabel(action, t) {
    if (!action) return '—';
    const entry = ACTIONS[action];
    return entry ? t(entry.key, entry.en) : action;
}

/** One category id (or audit marker) → its label. */
export function categoryLabel(id, t, map) {
    if (!id) return '';
    if (map?.has(id)) return map.get(id);
    const marker = MARKERS[id];
    return marker ? t(marker.key, marker.en) : id;
}

/**
 * Map stored category values (canonical ids or legacy labels) to UI labels.
 * Accepts a single id or a comma-joined column.
 */
export function useCategoryLabels(t) {
    return useMemo(() => {
        const map = new Map();
        for (const cat of piiCategoriesLocalized(t)) map.set(cat.id, cat.label);
        return (value) => {
            if (!value) return '';
            // Dedupe: legacy rows repeat the same label per occurrence
            // ("Person Name, Person Name, …"), which reads as noise.
            const parts = [...new Set(String(value).split(',').map(s => s.trim()).filter(Boolean))];
            return parts.map(id => categoryLabel(id, t, map)).join(', ');
        };
    }, [t]);
}

/**
 * Which surface produced this row — the "was this chat, an agent, or a
 * automation?" answer, as "Agent · Sales assistant". Sources across eras: 'direct'/'direct_chat',
 * 'agent'/'agent_chat'/'agent_stream', 'automation', 'notebook'. Automations also
 * carry automation_id (their title travels in agent_name).
 */
export function surfaceLabel(row, t) {
    const src = String(row?.source || '').toLowerCase();
    const named = (base, name) => (name ? `${base} · ${name}` : base);
    if (row?.automation_id || src === 'automation') {
        return named(t('admin.shield_activity_src_automation', 'Automation'), row.agent_name);
    }
    if (src.startsWith('agent') || (row?.agent_id && !src.startsWith('direct'))) {
        return named(t('admin.shield_activity_src_agent', 'Agent'), row.agent_name);
    }
    if (src.startsWith('direct')) return t('admin.shield_activity_src_direct', 'Direct chat');
    if (src.includes('notebook')) return t('admin.shield_activity_src_notebook', 'Notebook');
    return row?.agent_name || row?.source || '—';
}
