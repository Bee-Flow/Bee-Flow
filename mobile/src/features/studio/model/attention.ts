/**
 * "Needs attention" on the Studio hub — the rules, ported from the web's
 * attention/AttentionList.jsx and attentionChecks.js.
 *
 * An empty attention list is a SENTENCE: "nothing here needs you". It is only
 * true when every check answered, so the one line under the heading is
 * exactly one of five, and the pair it exists to keep apart is "we looked and
 * found nothing" against "we could not look everywhere". `complete` (the
 * endpoint's own field) is the only thing that tells them apart.
 */

import type { KindKey } from '@/shared/ui';

import type { StudioAttention } from './api';
import type { StudioSectionId } from './types';

export type AttentionLine = 'empty' | 'empty_capped' | 'empty_unchecked' | 'partial' | 'partial_capped' | null;

/** The line under the heading; null when there are rows and every check answered. */
export function attentionLine(attention: Pick<StudioAttention, 'total' | 'complete' | 'unavailable' | 'capped'>): AttentionLine {
    const onlyCapped = attention.unavailable.length === 0 && attention.capped.length > 0;
    if (attention.total === 0) {
        if (attention.complete) return 'empty';
        return onlyCapped ? 'empty_capped' : 'empty_unchecked';
    }
    if (attention.complete) return null;
    return onlyCapped ? 'partial_capped' : 'partial';
}

/**
 * The six attention sources (server/routes/studio/attentionChecks.js), each
 * named by the Studio section its kind belongs to — the web's SOURCE_LABELS
 * walked through the registry, so "Agents" in "Not checked: Agents" is the
 * same word as the Studio row.
 */
export const SOURCE_SECTION: Readonly<Record<string, StudioSectionId>> = {
    appValidation: 'apps',
    agentNoKb: 'agents',
    kbEmptyInUse: 'knowledge',
    automationFailing: 'aiTasks',
    solutionBlocked: 'solutions',
    kbSourceError: 'knowledge',
};

/**
 * One sentence per source — the web's SOURCE_LABELS keys and words. The phone
 * names a GROUP of findings with it ("App has validation problems · 12"),
 * where the web uses it only for a row that arrived without its own sentence.
 */
export const SOURCE_LABELS: Readonly<Record<string, readonly [key: string, fallback: string]>> = {
    appValidation: ['studio.attention.src_app_validation', 'App has validation problems'],
    agentNoKb: ['studio.attention.src_agent_no_kb', 'Agent has no knowledge base'],
    kbEmptyInUse: ['studio.attention.src_kb_empty_in_use', 'Knowledge base is used but holds no documents'],
    automationFailing: ['studio.attention.src_automation_failing', 'Routine failed several times in a row'],
    solutionBlocked: ['studio.attention.src_solution_blocked', 'Solution has blocking findings'],
    kbSourceError: ['studio.attention.src_kb_source_error', 'Knowledge source could not refresh'],
};

/** Source keys (bare, or `check:source` from a gap) → the sections they cover, once each. */
export function attentionSections(keys: readonly string[]): StudioSectionId[] {
    const out: StudioSectionId[] = [];
    for (const key of keys) {
        const bare = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
        const section = SOURCE_SECTION[key] ?? SOURCE_SECTION[bare];
        if (section && !out.includes(section)) out.push(section);
    }
    return out;
}

/** The worst severity on the list, which colours the heading's glyph. */
export function worstSeverity(rows: StudioAttention['rows']): 'error' | 'warning' | 'info' {
    if (rows.some((r) => r.severity === 'error')) return 'error';
    if (rows.some((r) => r.severity === 'warning')) return 'warning';
    return 'info';
}

/** The finding kinds (core/findings/finding.js FINDING_KINDS) the kit draws a tile for. */
const ROW_KINDS: readonly KindKey[] = [
    'automation', 'datatable', 'app', 'webpage', 'form', 'agent', 'skill', 'kb', 'meeting', 'solution',
];

export function rowKind(kind: string | null): KindKey | null {
    return kind && (ROW_KINDS as readonly string[]).includes(kind) ? (kind as KindKey) : null;
}
