/**
 * What kind of column is this? — decided ONCE, in the wizard.
 *
 * A worksheet has no column types, so the describe step looks at the cells
 * and proposes one per column; the linker confirms or changes it, and from
 * then on the type is declared (columns.js) and never re-inferred. The rules
 * are deliberately few so a person can predict them:
 *   • the first `SAMPLE_ROWS` (500) non-empty data rows are the sample;
 *   • every non-blank sampled cell gets a class — a date-formatted cell is a
 *     date (a datetime when it carries a clock), a boolean is a bool, a
 *     number is a number, a string is what it spells: yes/no/ja/nee/waar/
 *     onwaar/wel/niet → bool, an ISO or day-first date → date/datetime,
 *     something parseNumberish reads ("1.234,56", "€ 12") → number, else text;
 *   • the column is the class that ≥ 95 % of its sampled cells share (a
 *     stray "n.v.t." in a number column does not make it text; the strays
 *     are named in a warning and land NULL), otherwise text.
 * Only text / number / date / datetime / bool are ever proposed. `select` is
 * an opt-in the wizard offers per column — a heuristic that guesses "this
 * looks like a status column" is wrong often enough to be a nuisance.
 *
 * A date column's SPELLING (`dateFormat`, what the csv writer reproduces and
 * what readCell reads an ambiguous cell by) is decided by the cells that
 * could not be misread: '01/15/2026' says month-first, '03/04/2026' says
 * nothing (it is read day-first by default). Only the former vote; the
 * latter decide a column alone when no cell in the sample is unambiguous —
 * a column of first-of-the-month dates with one 01/15 in it is month-first,
 * not outvoted by its own guesses.
 *
 * Alongside the type, every column gets what the wizard shows and what the
 * link needs: display name and key (blank header → the column letter, key
 * `col_<letter>`; equal headers → "#2" by occurrence), ≤ 5 samples, and the
 * uniqueness facts over the FULL read — a column with no empties and no
 * duplicates is a key candidate.
 *
 * PURE: no database, no network.
 */

'use strict';

const { SpreadsheetSourceError } = require('./errors');
const cells = require('./cells');
const { describeHeader, keyFromTitle, columnLetter, INFERABLE_TYPES } = require('./columns');
const { normaliseKey, isBlankRow } = require('./identity');

const SAMPLE_ROWS = 500;
const THRESHOLD = 0.95;
const MAX_SAMPLES = 5;

// The spellings that make a STRING cell a boolean for inference — stricter
// than parseBoolish (no 'x', '1', '0': those are marks and numbers first).
const BOOL_WORD_RE = /^(true|false|yes|no|y|n|ja|nee|waar|onwaar|wel|niet)$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const DAY_FIRST_RE = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/;
const DAY_FIRST_TIME_RE = /^(\d{1,2}[-/.]\d{1,2}[-/.]\d{4})[T ]+\d{1,2}:\d{2}(:\d{2})?$/;

/**
 * The class of one non-blank cell: 'date' | 'datetime' | 'bool' | 'number' | 'text'.
 * The second value is the date spelling a string used (for csv write-back);
 * `guessed` says both halves of the day/month pair fit, so that spelling is
 * the default rather than a finding.
 */
function classifyCell(raw) {
    if (raw instanceof Date) return { cls: cells.hasTime(raw) ? 'datetime' : 'date', dateFormat: null };
    if (typeof raw === 'boolean') return { cls: 'bool', dateFormat: null };
    if (typeof raw === 'number') return { cls: Number.isFinite(raw) ? 'number' : 'text', dateFormat: null };
    const s = String(raw).trim();
    if (!s) return null;
    if (ISO_DATE_RE.test(s)) return cells.parseDateish(s) ? { cls: 'date', dateFormat: 'yyyy-mm-dd' } : { cls: 'text', dateFormat: null };
    if (ISO_DATETIME_RE.test(s)) return cells.parseDatetimeish(s) ? { cls: 'datetime', dateFormat: 'yyyy-mm-dd' } : { cls: 'text', dateFormat: null };
    if (DAY_FIRST_RE.test(s)) {
        const d = cells.parseDateishDetailed(s);
        return d ? { cls: 'date', dateFormat: d.format, guessed: d.ambiguous === true } : { cls: 'text', dateFormat: null };
    }
    const dt = DAY_FIRST_TIME_RE.exec(s);
    if (dt) {
        const d = cells.parseDateishDetailed(dt[1]);
        return d && cells.parseDatetimeish(s) ? { cls: 'datetime', dateFormat: d.format, guessed: d.ambiguous === true } : { cls: 'text', dateFormat: null };
    }
    if (Number.isFinite(cells.parseNumberish(s))) return { cls: 'number', dateFormat: null };
    if (BOOL_WORD_RE.test(s)) return { cls: 'bool', dateFormat: null };
    return { cls: 'text', dateFormat: null };
}

/** A cell as the wizard shows it in the samples column. */
function sampleText(raw) {
    if (raw instanceof Date) return cells.hasTime(raw) ? cells.isoDateTime(raw) : cells.isoDate(raw);
    return String(raw);
}

/**
 * @param {Array} header     the header cells (raw)
 * @param {Array<Array>} rows  the data rows (raw cells), the FULL read
 * @param {object} [opts]
 * @param {Set<number>} [opts.dateCols]     columns where the reader saw a date number format
 * @param {Set<number>} [opts.formulaCols]  columns where the reader saw a formula
 * @param {Map<number,string>} [opts.numFmts]  dominant Excel number format per column
 * @param {number} [opts.sampleRows]
 * @param {number} [opts.threshold]
 * @returns {{ columns:Array, keyCandidates:number[], warnings:string[] }}
 */
function inferColumns(header, rows, {
    dateCols = new Set(), formulaCols = new Set(), numFmts = new Map(),
    sampleRows = SAMPLE_ROWS, threshold = THRESHOLD,
} = {}) {
    const described = describeHeader(Array.isArray(header) ? header : []);
    if (!described.length || described.every(d => d.blankHeader)) {
        throw new SpreadsheetSourceError(422, 'header_missing',
            'The header row is empty — pick the row that holds the column names.');
    }
    const data = (Array.isArray(rows) ? rows : []).filter(r => !isBlankRow(r));
    const sample = data.slice(0, sampleRows);
    const warnings = [];
    const used = new Set();
    const columns = [];
    const keyCandidates = [];

    for (const d of described) {
        const col = d.col;
        // Pass 1: classes over the sample.
        const tally = { date: 0, datetime: 0, bool: 0, number: 0, text: 0 };
        const dateFormats = new Map();        // spellings the cells PROVED
        const guessedFormats = new Map();     // spellings that were the default for an ambiguous pair
        let sampled = 0;
        for (const r of sample) {
            const raw = r[col];
            if (cells.isBlank(raw)) continue;
            // A plain number in a column the reader saw date formats in is a
            // serial whose cell lost its format — readCell reads it as one.
            const c = (dateCols.has(col) && typeof raw === 'number')
                ? classifyCell(cells.serialToDate(raw) || raw)
                : classifyCell(raw);
            if (!c) continue;
            sampled += 1;
            tally[c.cls] += 1;
            if (c.dateFormat) {
                const votes = c.guessed ? guessedFormats : dateFormats;
                votes.set(c.dateFormat, (votes.get(c.dateFormat) || 0) + 1);
            }
        }
        let type = 'text';
        let strays = 0;
        if (sampled > 0) {
            const dates = tally.date + tally.datetime;
            const best = [['number', tally.number], ['bool', tally.bool], ['dates', dates]]
                .sort((a, b) => b[1] - a[1])[0];
            if (best[1] / sampled >= threshold) {
                type = best[0] === 'dates' ? (tally.datetime > 0 ? 'datetime' : 'date') : best[0];
                strays = sampled - best[1];
            }
        }
        if (!INFERABLE_TYPES.includes(type)) type = 'text';

        // Pass 2: the facts over the full read.
        let nonEmpty = 0;
        let empties = 0;
        const distinct = new Set();
        const samples = [];
        const seenSamples = new Set();
        for (const r of data) {
            const raw = r[col];
            if (cells.isBlank(raw)) { empties += 1; continue; }
            nonEmpty += 1;
            const norm = normaliseKey(raw);
            if (norm !== null) distinct.add(norm);
            if (samples.length < MAX_SAMPLES) {
                const s = sampleText(raw);
                if (!seenSamples.has(s)) { seenSamples.add(s); samples.push(s); }
            }
        }
        const formula = formulaCols.has(col);
        const unique = (type === 'text' || type === 'number') && nonEmpty > 0 && empties === 0 && distinct.size === nonEmpty;
        const key = keyFromTitle(d.blankHeader ? `col_${d.letter.toLowerCase()}` : d.name, col + 1, used);
        used.add(key);

        const column = {
            col, letter: d.letter, header: d.header, name: d.name, key, type,
            formula, blankHeader: d.blankHeader, duplicateHeader: d.duplicateHeader,
            samples, nonEmpty, empties, distinct: distinct.size, unique,
        };
        const numFmt = numFmts.get(col);
        if (numFmt) column.numFmt = numFmt;
        const format = (type === 'date' || type === 'datetime') ? 'date' : cells.formatOfNumFmt(numFmt);
        if (format) column.format = format;
        if (type === 'date' || type === 'datetime') {
            // The proven spellings decide; the guesses only when nothing was proven.
            const votes = dateFormats.size ? dateFormats : guessedFormats;
            if (votes.size) column.dateFormat = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        columns.push(column);
        if (unique && !formula) keyCandidates.push(col);

        if (d.blankHeader) warnings.push(`Column ${d.letter} has no header; it is shown as "${d.letter}".`);
        if (d.duplicateHeader) warnings.push(`More than one column is called "${d.header}"; column ${d.letter} is shown as "${d.name}".`);
        if (formula) warnings.push(`"${d.name}" holds formulas, so it is read-only here.`);
        if (strays > 0) {
            warnings.push(`${strays} of ${sampled} values in "${d.name}" are not a ${typeWord(type)} and will be empty.`);
        }
    }

    return { columns, keyCandidates, warnings };
}

function typeWord(type) {
    return type === 'bool' ? 'yes/no value' : type === 'datetime' ? 'date and time' : type;
}

module.exports = { inferColumns, classifyCell, SAMPLE_ROWS, THRESHOLD, MAX_SAMPLES, columnLetter };
