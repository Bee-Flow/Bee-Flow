/**
 * "Worth a look": the few things in a window an admin should act on or know.
 *
 * Built from the WINDOW's aggregates only (never the ≤200-row sample), so a
 * finding says the same thing whatever filter is on — which is also what
 * lets its "Show these" button read "Showing these" while its filter is on.
 *
 * Every finding is a claim the data can back:
 *
 *  - tool_pii      calls that left with personal data (`pii_events`), how
 *                  many went outside Europe (`pii_non_eu_count`), the hosts
 *                  that received the most, and how many kinds tools hold back.
 *  - via_network   calls through a global network. Only the network's edge is
 *                  known, never where the service behind it runs, so this
 *                  says exactly that — no vendor's processing location.
 *  - unknown       calls to a server with no known location, with the hosts
 *                  and how often calls to them carried personal data.
 *  - low_score     the share of calls that stayed in Europe below the alert
 *                  threshold — the same figure as the "Stayed in Europe" KPI,
 *                  so the pane never shows two different percentages.
 *  - many_catches  a lot of personal data in messages.
 *  - protected     nothing got past the shield: no shield event let anything
 *                  through, no tool call carried personal data out, and the
 *                  shield did act. Only then, never by default.
 *
 * Pure: the pane turns ids and vars into words.
 */

import type { Region } from '../shieldPalette';

export type FindingId = 'tool_pii' | 'via_network' | 'unknown' | 'low_score' | 'many_catches' | 'protected';
export type FindingTone = 'warn' | 'info' | 'good';

/** A filter a finding's "Show these" toggles. */
export type FindingAction =
    | { axis: 'outcome'; value: 'tool' }
    | { axis: 'region'; value: Region }
    | { axis: 'pii'; value: true };

export interface Finding {
    id: FindingId;
    tone: FindingTone;
    vars: Record<string, number | string>;
    action?: FindingAction;
    /** A pane that fixes it ("Hold kinds back from tools" → detection). */
    link?: 'detection';
}

interface Destination {
    dest_host?: string | null;
    host?: string | null;
    location_state?: string | null;
    network?: string | null;
    total?: unknown;
    pii_events?: unknown;
}

export interface FindingsInput {
    summary: Record<string, unknown>;
    destinations: Destination[];
    /** The shield's own events: `pii_count` from the guard summary. */
    guardPiiCount: number;
    replaced: number;
    stopped: number;
    passed: number;
    /** Kinds of personal data tools hold back, of all kinds. Absent when unknown. */
    toolHoldBack?: { held: number; total: number } | null;
    /** Share of placed calls that stayed on your server or in Europe (shieldTotals.stayedInEurope); null when none was placed. */
    stayedPct: number | null;
    /** Alert thresholds (config/analyticsConfig). */
    scoreThreshold: number;
    catchesThreshold: number;
}

const num = (v: unknown): number => Number(v) || 0;
const hostOf = (d: Destination): string => String(d.dest_host || d.host || '');

/** The busiest hosts by `key`, most first, ties alphabetical. */
function topHosts(dests: Destination[], key: 'pii_events' | 'total', limit: number): string[] {
    return dests
        .filter(d => hostOf(d) && num(d[key]) > 0)
        .sort((a, b) => (num(b[key]) - num(a[key])) || hostOf(a).localeCompare(hostOf(b)))
        .slice(0, limit)
        .map(hostOf);
}

function toolPii(input: FindingsInput): Finding | null {
    const n = num(input.summary.pii_events);
    if (n <= 0) return null;
    const hosts = topHosts(input.destinations, 'pii_events', 2);
    return {
        id: 'tool_pii',
        tone: 'warn',
        vars: {
            n,
            outside: num(input.summary.pii_non_eu_count),
            hostA: hosts[0] || '',
            hostB: hosts[1] || '',
            held: input.toolHoldBack ? input.toolHoldBack.held : -1,
            total: input.toolHoldBack ? input.toolHoldBack.total : -1,
        },
        action: { axis: 'outcome', value: 'tool' },
        link: 'detection',
    };
}

/** The network most calls went through, by name; '' when none was named. */
function busiestNetwork(dests: Destination[]): string {
    const calls = new Map<string, number>();
    for (const d of dests) {
        if (d.location_state !== 'via_network' || !d.network) continue;
        calls.set(d.network, (calls.get(d.network) || 0) + num(d.total));
    }
    return [...calls.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0]?.[0] || '';
}

function viaNetwork(input: FindingsInput): Finding | null {
    const n = num(input.summary.via_network_count);
    if (n <= 0) return null;
    return {
        id: 'via_network',
        tone: 'info',
        vars: { n, network: busiestNetwork(input.destinations) },
        action: { axis: 'region', value: 'via_network' },
    };
}

function unknownPlace(input: FindingsInput): Finding | null {
    const n = num(input.summary.unknown_count);
    if (n <= 0) return null;
    const unplaced = input.destinations.filter(d => d.location_state === 'unknown');
    const hosts = topHosts(unplaced, 'total', 2);
    return {
        id: 'unknown',
        tone: 'warn',
        vars: {
            n,
            hosts: hosts.join(', '),
            more: Math.max(0, unplaced.filter(d => hostOf(d)).length - hosts.length),
            pii: unplaced.reduce((s, d) => s + num(d.pii_events), 0),
        },
        action: { axis: 'region', value: 'unknown' },
    };
}

function lowScore(input: FindingsInput): Finding | null {
    const pct = input.stayedPct;
    if (pct === null || pct >= input.scoreThreshold) return null;
    return { id: 'low_score', tone: 'warn', vars: { score: pct }, action: { axis: 'region', value: 'outside' } };
}

function manyCatches(input: FindingsInput): Finding | null {
    if (input.guardPiiCount <= input.catchesThreshold) return null;
    return { id: 'many_catches', tone: 'info', vars: { n: input.guardPiiCount }, action: { axis: 'pii', value: true } };
}

function protectedAll(input: FindingsInput): Finding | null {
    const acted = input.replaced + input.stopped;
    // "Nothing got past" beside "83 tool calls carried personal data out"
    // would be a false all-clear.
    if (input.passed !== 0 || acted <= 0 || num(input.summary.pii_events) > 0) return null;
    return { id: 'protected', tone: 'good', vars: { n: acted } };
}

/** The findings for a window, warnings first, the good news last. */
export function deriveFindings(input: FindingsInput): Finding[] {
    return [toolPii, viaNetwork, unknownPlace, lowScore, manyCatches, protectedAll]
        .map(build => build(input))
        .filter((f): f is Finding => f !== null);
}

/** Is this finding's filter the one that is on? */
export function isShowing(finding: Finding, filters: Record<string, unknown>): boolean {
    if (!finding.action) return false;
    const current = filters[finding.action.axis];
    return current !== undefined && current !== null && String(current) === String(finding.action.value);
}
