/**
 * The last 30 days in numbers, for every pane of the Privacy Shield that is
 * not "What happened" itself: the Overview's review card and "Last 30 days",
 * the strip, the tool-gap note on the checks pane, and "left with tools" in
 * the category matrix.
 *
 * ── Why the editor fetches this, and not only the activity pane ──────────
 * These panes judge settings against what actually happened ("no kind is held
 * back from tools — and 83 tool calls carried personal data out"). That used
 * to be known only after someone had opened "What happened", which lifted a
 * number back up; the Overview then changed its mind mid-session. Now the two
 * AGGREGATE endpoints are fetched once, without the detail rows and without
 * polling, when the mount offers the activity pane at all.
 *
 * ── Where it must NOT run ─────────────────────────────────────────────────
 * The usage endpoints take the organisation from the SESSION. The admin
 * console mount can pin a different organisation, so it never offers the
 * activity pane and never gets these figures (`enabled` is false there, and
 * on a plan without `advanced_usage_monitoring`). `null` then means "unknown",
 * and every consumer must render nothing rather than a zero.
 */

import { useMemo } from 'react';

import { sumByAction, type ByActionRow } from './outcomes';
import useShieldActivity from './useShieldActivity';

/** The window every consumer names in its copy ("in the last 30 days"). */
export const EVIDENCE_DAYS = 30;

export interface ShieldEvidence {
    days: number;
    /** Shield events where personal data was replaced by placeholders or removed. */
    replaced: number;
    /** Shield events where the message, search or tool call was stopped. */
    stopped: number;
    /** Shield events where personal data was found and went out anyway. */
    passed: number;
    /** Calls to outside services that carried personal data (`pii_events`). */
    toolPii: number;
    /** …of which to a server outside Europe (`pii_non_eu_count`). */
    piiNonEuCount: number;
    /** All calls to outside services, and where they went. */
    totalCalls: number;
    /**
     * Calls whose content was checked for personal data (`health.scan_levels`
     * full + basic). With none, `toolPii` 0 means "not looked", never "none".
     */
    scannedCalls: number;
    local: number;
    eu: number;
    outside: number;
    viaNetwork: number;
    unknown: number;
    /** Canonical category id → calls to outside services that carried it. */
    toolKinds: Record<string, number>;
    /** The three categories that left with tools most often, most first. */
    topToolKinds: string[];
}

interface Overview {
    summary?: Record<string, unknown>;
    by_action?: ByActionRow[];
    pii_categories?: Array<{ category?: string; pii_category?: string; count?: number | string }>;
    health?: { scan_levels?: { full?: unknown; basic?: unknown; none?: unknown } | null } | null;
}

const num = (v: unknown): number => Number(v) || 0;

/** Pure: the two overview responses → the figures above. */
export function deriveEvidence(guard: Overview | null | undefined, integ: Overview | null | undefined): ShieldEvidence {
    const g = guard || {};
    const i = integ || {};
    const s = i.summary || {};
    const acted = sumByAction(g.by_action);
    const toolKinds: Record<string, number> = {};
    for (const row of i.pii_categories || []) {
        const id = String(row.category || row.pii_category || '').trim();
        if (!id) continue;
        toolKinds[id] = (toolKinds[id] || 0) + num(row.count);
    }
    const topToolKinds = Object.entries(toolKinds)
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([id]) => id);
    return {
        days: EVIDENCE_DAYS,
        ...acted,
        toolPii: num(s.pii_events),
        piiNonEuCount: num(s.pii_non_eu_count),
        totalCalls: num(s.total_calls),
        scannedCalls: num(i.health?.scan_levels?.full) + num(i.health?.scan_levels?.basic),
        local: num(s.local_count),
        eu: num(s.eu_count),
        outside: num(s.non_eu_count),
        viaNetwork: num(s.via_network_count),
        unknown: num(s.unknown_count),
        toolKinds,
        topToolKinds,
    };
}

const RANGE = { days: EVIDENCE_DAYS };

/**
 * @param enabled  The mount offers the activity pane AND the plan has the
 *   monitoring licence. Anything else fetches nothing and returns null.
 */
export default function useShieldEvidence({ enabled }: { enabled: boolean }): ShieldEvidence | null {
    const { loaded, error, guard, integ } = useShieldActivity({
        enabled,
        rangeParams: RANGE,
        detail: false,
        poll: false,
    });
    return useMemo(() => {
        if (!enabled || !loaded || error) return null;
        return deriveEvidence(guard, integ);
    }, [enabled, loaded, error, guard, integ]);
}
