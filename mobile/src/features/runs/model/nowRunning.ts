/**
 * The model behind the "Now running · last 24 hours" strip — a port of
 * agent-hub/src/components/admin/Studio/Runs/nowRunning.js, pinned to it by
 * nowRunning.lockstep.test.ts (both run on the same facets).
 *
 * One line per automation that ran in the window, drawn from the facets'
 * `automations` rollup rather than from the list below it: the list shows one
 * page, the strip is a claim about the whole window.
 *
 * The rule this file holds: AN UNREADABLE ROLLUP IS NOT AN EMPTY ONE.
 * `readRollups` answers null — never [] — for facets that never arrived,
 * failed, or came from a server without the rollup, so the strip can say "I
 * do not know" instead of "nothing is running". And the error shown is a
 * CLASS, never the message: in the organisation scope the message can quote
 * somebody else's customer.
 */

import type { RunFacets, RunRollup } from './types';

/** How many lines the strip draws before it says "and n more". */
export const NOW_RUNNING_LIMIT = 6;

const RUNNING = new Set(['running', 'queued']);
const ERROR_ONLY = new Set(['error']);
const WAITING = new Set(['awaiting_approval', 'awaiting_confirm', 'awaiting_form']);

/** Most urgent first; the index IS the sort rank. */
export const NOW_RUNNING_TONES = Object.freeze(['error', 'waiting', 'running', 'done'] as const);
export type NowRunningTone = (typeof NOW_RUNNING_TONES)[number];

export interface NowRunningLine {
    automationId: string;
    title: string | null;
    kind: 'block' | 'automation';
    tone: NowRunningTone;
    total: number;
    errors: number;
    waiting: number;
    running: number;
    errorClass: string | null;
    at: string | null;
}

export interface NowRunningModel {
    lines: NowRunningLine[];
    total: number;
    hidden: number;
}

function countIn(statusMap: Record<string, number> | null | undefined, set: ReadonlySet<string>): number {
    if (!statusMap || typeof statusMap !== 'object') return 0;
    let n = 0;
    for (const [key, value] of Object.entries(statusMap)) {
        if (set.has(String(key)) && Number.isFinite(Number(value))) n += Number(value);
    }
    return n;
}

/** The rollups, or null when there are none to read (see the header). */
export function readRollups(facets: RunFacets | null | undefined): RunRollup[] | null {
    if (!facets || typeof facets !== 'object' || Array.isArray(facets)) return null;
    if (!Array.isArray(facets.automations)) return null;
    return facets.automations.filter((r) => r && typeof r === 'object' && r.automationId);
}

function titleOf(rollup: RunRollup): string | null {
    return typeof rollup.title === 'string' && rollup.title.trim() ? rollup.title : null;
}

/**
 * One rollup, one line. The tone is the most urgent thing in the window, not
 * the most recent: an automation that failed this morning and succeeded since is
 * still one somebody should look at.
 */
export function toLine(rollup: RunRollup): NowRunningLine {
    const total = Number.isFinite(Number(rollup.total)) ? Number(rollup.total) : 0;
    const errors = countIn(rollup.status, ERROR_ONLY);
    const waiting = countIn(rollup.status, WAITING);
    const running = countIn(rollup.status, RUNNING);
    const tone: NowRunningTone = errors > 0 ? 'error' : waiting > 0 ? 'waiting' : running > 0 ? 'running' : 'done';
    return {
        automationId: String(rollup.automationId),
        title: titleOf(rollup),
        kind: rollup.kind === 'block' ? 'block' : 'automation',
        tone,
        total,
        errors,
        waiting,
        running,
        errorClass: tone === 'error' && rollup.lastErrorClass ? String(rollup.lastErrorClass) : null,
        at: (tone === 'error' ? rollup.lastErrorAt : null) || rollup.lastRunAt || null,
    };
}

/**
 * The strip, or null when the rollup could not be read. `hidden` counts the
 * automations that did not fit, including the ones past the server's own cap
 * (`automationsTotal`), so "3 automations" never stands in for "3 of 40".
 */
export function nowRunningLines(
    facets: RunFacets | null | undefined,
    { limit = NOW_RUNNING_LIMIT }: { limit?: number } = {},
): NowRunningModel | null {
    const rollups = readRollups(facets);
    if (!rollups) return null;
    const lines = rollups.map(toLine).sort((a, b) => {
        const rank = NOW_RUNNING_TONES.indexOf(a.tone) - NOW_RUNNING_TONES.indexOf(b.tone);
        if (rank !== 0) return rank;
        return String(b.at || '').localeCompare(String(a.at || ''));
    });
    const serverTotal = Number(facets?.automationsTotal);
    const total = Number.isFinite(serverTotal) && serverTotal >= lines.length ? serverTotal : lines.length;
    return { lines: lines.slice(0, limit), total, hidden: Math.max(0, total - Math.min(lines.length, limit)) };
}
