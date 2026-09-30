/**
 * What an import sends and how its answer reads (the web's ImportPanel.start):
 * rows the phone could not convert never leave it, but are reported by the
 * same line number the server uses, so the two halves read as one list. The
 * server counts from 1 over the rows IT was sent; that is mapped back to the
 * line in the file the person is looking at.
 */

import type { ImportRow } from './csvImport';
import type { BulkImportResult } from './types';

export interface LineProblem {
    line: number;
    /** A converted cell's problem, or the server's own sentence. */
    problems: ImportRow['problems'];
    error?: string;
}

export interface ImportPlan {
    good: ImportRow[];
    skipped: LineProblem[];
}

export function planImport(built: readonly ImportRow[]): ImportPlan {
    return {
        good: built.filter((r) => r.problems.length === 0 && Object.keys(r.values).length > 0),
        skipped: built.filter((r) => r.problems.length > 0).map((r) => ({ line: r.line, problems: r.problems })),
    };
}

/** Every line that did not land, in file order. */
export function importOutcome(plan: ImportPlan, answer: BulkImportResult): { inserted: number; failed: LineProblem[] } {
    const server = answer.errors.map((e) => ({ line: plan.good[e.line - 1]?.line ?? e.line, problems: [], error: e.error }));
    return { inserted: answer.inserted, failed: [...plan.skipped, ...server].sort((a, b) => a.line - b.line) };
}
