// More outputs than this is not a routing decision any more, it is a lookup
// table — and every extra output is a port on the canvas that someone has to
// wire. A description that produces more is truncated and says so.
export const MAX_RULES = 8;

const ISO_DATE = '\\d{4}-\\d{2}-\\d{2}';

const ISO_DATE_RE = new RegExp(`^${ISO_DATE}$`);

// ── Picking the field to compare ────────────────────────────────────────
export const FILE_NAME_KEYS = /^(file|files|filename|file_name|name|path|filepath|attachment|attachments|document)$/;

export const TEXT_KEYS = /^(subject|title|name|body|text|message|content|description|summary|snippet)$/;

export const NUMBER_KEYS = /(amount|total|price|count|quantity|qty|score|size|bytes|number|age|days)$/;

export const DATE_KEYS = /(date|created|updated|modified|due|sent|received|timestamp|time|at)$/;

// ── Intent: contains ────────────────────────────────────────────────────
export const QUOTED_RE = /"([^"]+)"|'([^']+)'|“([^”]+)”/g;

// A bare "with" is NOT a lead-in. "do the usual thing with these" is not a
// request to match the word "these", and a box that answers a shrug with a
// confident rule is worse than one that says it did not understand.
export const CONTAINS_LEAD = /\b(?:contains?|containing|mentions?|mentioning|includes?|including|with the words?)\s+(.+)$/i;

// ── Intent: dates ───────────────────────────────────────────────────────
export const DATE_CLAUSES = [
    { re: new RegExp(`\\bbetween\\s+(${ISO_DATE})\\s+(?:and|to|until)\\s+(${ISO_DATE})`, 'g'), kind: 'between' },
    { re: new RegExp(`\\b(?:before|earlier than|prior to|up to)\\s+(${ISO_DATE})`, 'g'), kind: 'before' },
    // "after the 1st" excludes the 1st; "since/from the 1st" includes it.
    // Two different asks, so two patterns — and the exclusive bound is built
    // from the NEXT day (see nextDay) so a timestamp at 09:00 on the 1st is
    // not quietly read as "after the 1st".
    { re: new RegExp(`\\bafter\\s+(${ISO_DATE})`, 'g'), kind: 'after' },
    { re: new RegExp(`\\b(?:since|from|on or after)\\s+(${ISO_DATE})`, 'g'), kind: 'since' },
    { re: new RegExp(`\\bon\\s+(${ISO_DATE})`, 'g'), kind: 'on' },
];

// A date was clearly meant, but not in a form a pure function can resolve.
export const DATE_WORDS = /\b(before|after|since|older than|newer than|last (?:week|month|year|\d+ days?)|this (?:week|month|year)|yesterday|today|tomorrow|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/;

// ── Intent: numbers ─────────────────────────────────────────────────────
const NUM = '(-?[\\d][\\d,]*(?:\\.\\d+)?)';

export const NUMBER_CLAUSES = [
    { re: new RegExp(`\\bbetween\\s+${NUM}\\s+(?:and|to)\\s+${NUM}`, 'g'), kind: 'between' },
    { re: new RegExp(`\\b(?:over|more than|greater than|above|higher than|bigger than)\\s+${NUM}`, 'g'), kind: 'gt' },
    { re: new RegExp(`\\b(?:under|less than|below|lower than|smaller than)\\s+${NUM}`, 'g'), kind: 'lt' },
    { re: new RegExp(`\\b(?:at least|minimum of|minimum|no less than)\\s+${NUM}`, 'g'), kind: 'gte' },
    { re: new RegExp(`\\b(?:at most|no more than|maximum of|maximum|up to)\\s+${NUM}`, 'g'), kind: 'lte' },
];

export const NUMBER_SYMBOL: Record<string, string> = { gt: '>', lt: '<', gte: '>=', lte: '<=' };

export const NUMBER_WORD: Record<string, string> = { gt: 'over', lt: 'under', gte: 'at least', lte: 'at most' };
