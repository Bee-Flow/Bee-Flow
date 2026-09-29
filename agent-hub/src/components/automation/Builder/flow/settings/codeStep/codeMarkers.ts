// Findings as editor markers, and a line jump that works in both editors.

import type { CodeAnalysis } from '../../../../../../api/queries/automation/codeStep';

export interface MarkerData {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    message: string;
    severity: number;
    source: string;
}

/** Monaco's MarkerSeverity values, so this module needs no Monaco import. */
const SEVERITY = { block: 8, warn: 4, info: 2 } as const;

/** One marker per finding (and the syntax error), in the author's words. */
export function markersFor(
    analysis: CodeAnalysis | null | undefined,
    say: (key: string | null, english: string) => string,
): MarkerData[] {
    if (!analysis) return [];
    const out: MarkerData[] = analysis.findings.map(f => ({
        startLineNumber: f.line,
        startColumn: Math.max(1, f.column),
        endLineNumber: f.endLine ?? f.line,
        endColumn: f.endColumn ?? Math.max(1, f.column) + 200,
        message: say(f.messageKey, f.message),
        severity: SEVERITY[f.severity],
        source: 'Bee Flow',
    }));
    if (analysis.syntaxError) {
        const s = analysis.syntaxError;
        out.push({
            startLineNumber: s.line, startColumn: Math.max(1, s.column), endLineNumber: s.line, endColumn: Math.max(1, s.column) + 200,
            message: s.message, severity: SEVERITY.block, source: 'Bee Flow',
        });
    }
    return out;
}

/** Where line `line` starts and ends in `text` (1-based line), for a textarea selection. */
export function lineRange(text: string, line: number): { start: number; end: number } {
    const lines = String(text || '').split('\n');
    const target = Math.min(Math.max(1, line), Math.max(1, lines.length));
    let start = 0;
    for (let i = 0; i < target - 1; i++) start += lines[i].length + 1;
    return { start, end: start + (lines[target - 1] || '').length };
}
