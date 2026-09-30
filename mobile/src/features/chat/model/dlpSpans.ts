/**
 * The findings of a DLP review as spans over the reviewed text, the marks a
 * person added, and the text cut into plain and highlighted runs — the port
 * of agent-hub/src/components/chat/dlpReview/dlpFindingsState.js (pinned by
 * dlpSpans.lockstep.test.ts).
 *
 * Overlapping spans collapse into one: a person's own mark wins, else the
 * longest finding, and the merged span covers them all — two highlights on
 * the same characters would read as two things to redact.
 */

import type { DlpFinding } from './types';

export interface DlpSpan extends DlpFinding {
    offset: number;
    length: number;
}

/** A mark the person added: where it is, and the words it covers. */
export interface ManualMark {
    id: string;
    offset: number;
    length: number;
    text?: string;
}

export type DlpRun = { type: 'text'; value: string } | (DlpSpan & { type: 'span'; value: string });

function usable(span: DlpFinding | null | undefined): span is DlpSpan {
    return Boolean(
        span &&
            Number.isInteger(span.offset) &&
            (span.offset as number) >= 0 &&
            Number.isInteger(span.length) &&
            (span.length as number) > 0,
    );
}

function collapse(cluster: DlpSpan[]): DlpSpan {
    if (cluster.length === 1) return cluster[0] as DlpSpan;
    let offset = (cluster[0] as DlpSpan).offset;
    let end = offset + (cluster[0] as DlpSpan).length;
    for (const c of cluster) {
        if (c.offset < offset) offset = c.offset;
        if (c.offset + c.length > end) end = c.offset + c.length;
    }
    const manual = cluster.find((s) => s.source === 'manual');
    const winner = manual || cluster.reduce((a, b) => (b.length > a.length ? b : a));
    return { ...winner, offset, length: end - offset };
}

/** The server's findings and the person's marks, sorted and merged where they overlap. */
export function mergeSpans(autoFindings: readonly DlpFinding[] | undefined, manualSpans: readonly ManualMark[] | undefined): DlpSpan[] {
    const manual: DlpFinding[] = (manualSpans ?? []).map((m) => ({
        ...m,
        source: 'manual',
        category: 'UserMarked',
        confidenceBand: null,
    }));
    const all = [...(autoFindings ?? []), ...manual].filter(usable);
    if (all.length === 0) return [];
    all.sort((a, b) => a.offset - b.offset || b.length - a.length);
    const out: DlpSpan[] = [];
    let cluster = [all[0] as DlpSpan];
    let clusterEnd = (all[0] as DlpSpan).offset + (all[0] as DlpSpan).length;
    for (const s of all.slice(1)) {
        if (s.offset < clusterEnd) {
            cluster.push(s);
            if (s.offset + s.length > clusterEnd) clusterEnd = s.offset + s.length;
        } else {
            out.push(collapse(cluster));
            cluster = [s];
            clusterEnd = s.offset + s.length;
        }
    }
    out.push(collapse(cluster));
    return out;
}

/** The spans inside a window of the text, re-based to the window's start. */
export function spansInRange(spans: readonly DlpSpan[], start: number, end: number): DlpSpan[] {
    return spans.filter((s) => s.offset >= start && s.offset + s.length <= end).map((s) => ({ ...s, offset: s.offset - start }));
}

/** The text as alternating plain and highlighted runs, in offset order. */
export function buildRuns(text: string, spans: readonly DlpSpan[]): DlpRun[] {
    const runs: DlpRun[] = [];
    let cursor = 0;
    for (const s of spans) {
        if (s.offset > cursor) runs.push({ type: 'text', value: text.slice(cursor, s.offset) });
        runs.push({ ...s, type: 'span', value: text.slice(s.offset, s.offset + s.length) });
        cursor = s.offset + s.length;
    }
    if (cursor < text.length) runs.push({ type: 'text', value: text.slice(cursor) });
    return runs;
}

/**
 * The phone's way to add a mark: a tap on a word. Selecting a character range
 * with a finger is the web's gesture and has no good native equivalent, so a
 * plain run is offered word by word — each word a span of its own that a tap
 * turns into a mark. Whitespace stays plain.
 */
export function wordsOf(value: string, base: number): { word: string; offset: number; length: number }[] {
    const out: { word: string; offset: number; length: number }[] = [];
    for (const m of value.matchAll(/\S+/g)) out.push({ word: m[0], offset: base + (m.index ?? 0), length: m[0].length });
    return out;
}

/** The runs with where each starts in the text — what a tap on a word needs to mark it. */
export function positionedRuns(text: string, spans: readonly DlpSpan[]): (DlpRun & { start: number })[] {
    let start = 0;
    return buildRuns(text, spans).map((run) => {
        const at = start;
        start += run.value.length;
        return { ...run, start: at };
    });
}

export type WordPiece = { kind: 'gap'; text: string } | { kind: 'word'; word: string; offset: number; length: number };

/** A plain run cut into its words and the gaps between them, each word with its place in the whole text. */
export function wordPieces(value: string, base: number): WordPiece[] {
    const out: WordPiece[] = [];
    let cursor = 0;
    for (const w of wordsOf(value, base)) {
        const local = w.offset - base;
        if (local > cursor) out.push({ kind: 'gap', text: value.slice(cursor, local) });
        out.push({ kind: 'word', ...w });
        cursor = local + w.length;
    }
    if (cursor < value.length) out.push({ kind: 'gap', text: value.slice(cursor) });
    return out;
}
