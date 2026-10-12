// Words for the inline "Ask AI": what the selection is called, and the one
// sentence of a long reply that fits in a toast.

import type { TranslateFn } from '../../../hooks/useTranslation';
import { cellName, columnName } from './sheetEngine';
import type { Range, SelectionKind } from './sheetModel';

const MAX_TOAST_CHARS = 160;

/** "C2", "C2:C40", "column C", "columns B–D", "row 3", "rows 3–5". */
export function selectionLabel(t: TranslateFn, r: Range, kind: SelectionKind): string {
    if (kind === 'columns') {
        return r.c1 === r.c2
            ? t('spreadsheet.select.column', 'column {name}', { name: columnName(r.c1) })
            : t('spreadsheet.select.columns', 'columns {from}–{to}', { from: columnName(r.c1), to: columnName(r.c2) });
    }
    if (kind === 'rows') {
        return r.r1 === r.r2
            ? t('spreadsheet.select.row', 'row {n}', { n: r.r1 + 1 })
            : t('spreadsheet.select.rows', 'rows {from}–{to}', { from: r.r1 + 1, to: r.r2 + 1 });
    }
    const from = cellName(r.c1, r.r1);
    return kind === 'cell' ? from : `${from}:${cellName(r.c2, r.r2)}`;
}

/** The first sentence of a reply as plain text (markdown marks dropped), cut to fit a toast. */
export function firstSentence(reply: string): string {
    const plain = reply
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^\s*(?:#{1,6}|[-*>]|\d+[.)])\s+/gm, '')
        .replace(/[*_`]/g, '')
        .trim();
    const line = plain.split(/\n+/)[0] ?? '';
    const end = /[.!?](?=\s|$)/.exec(line);
    const sentence = (end ? line.slice(0, end.index + 1) : line).trim();
    return sentence.length > MAX_TOAST_CHARS ? `${sentence.slice(0, MAX_TOAST_CHARS - 1).trimEnd()}…` : sentence;
}
