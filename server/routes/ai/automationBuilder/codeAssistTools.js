/**
 * The code assistant's edit tools (POST /api/automation/builder/code/assist).
 *
 * Four tools over ONE text, the code of one code step, applied in memory to
 * the copy the request carried. Nothing here saves: the client shows the
 * result with Keep/Undo and its own autosave writes the step.
 *
 *   code_read     the code with line numbers (optionally a range)
 *   code_replace  exact find/replace, empty replacement deletes, replace_all
 *   code_patch    replace a line range, guarded by the text those lines hold
 *   code_write    replace the whole code
 *
 * The find/replace ladder is core/text/findReplace.js, the one Documents and
 * the webpage tools run, so "which occurrence did the model mean" has one
 * answer everywhere. What is added here is tolerance for the two mistakes a
 * small model makes with a numbered listing: copying the line numbers into
 * find_text or into a whole-code write, and wrapping a write in a Markdown
 * fence. Both are undone before the edit is applied, never written into the
 * step.
 *
 * Pure: text in, text out, no I/O.
 */

'use strict';

const { applyFindReplace, normalizeWhitespace, truncate } = require('../../../core/text/findReplace');

// The most code one step may hold after an edit. Far above any real code
// step; it exists so a runaway write cannot grow the request's copy without
// bound.
const MAX_CODE_CHARS = 100_000;

// Lines shown back to the model around an edit, so it can see what landed
// without another read.
const EXCERPT_CONTEXT_LINES = 2;
const EXCERPT_MAX_LINES = 30;

const SUMMARY_PROP = {
    type: 'string',
    description: 'A few words in the person\'s language saying what this edit does, e.g. "Added the VAT rate". Shown to the person.',
};

const CODE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'code_read',
            description: 'Read the current code with line numbers. The numbers are NOT part of the code: never copy them into an edit. Optional start_line/end_line read a range.',
            parameters: {
                type: 'object',
                properties: {
                    start_line: { type: 'integer', description: 'First line to read (1-based). Default 1.' },
                    end_line: { type: 'integer', description: 'Last line to read (inclusive). Default: the last line.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'code_replace',
            description: 'Change one exact piece of the code and keep the rest. find_text is copied exactly from the current code (without line numbers) and must match once; set replace_all to change every match. replace_text "" DELETES the piece. To INSERT, use a nearby line as find_text and repeat it in replace_text together with the new lines. Preferred for most edits.',
            parameters: {
                type: 'object',
                properties: {
                    find_text: { type: 'string', description: 'The exact text to find in the current code.' },
                    replace_text: { type: 'string', description: 'What goes in its place. "" deletes find_text.' },
                    replace_all: { type: 'boolean', description: 'true: replace every match. Default false: find_text must match exactly once.' },
                    summary: SUMMARY_PROP,
                },
                required: ['find_text', 'replace_text', 'summary'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'code_patch',
            description: 'Replace the lines start_line..end_line (1-based, inclusive) with new lines. expected_text is what those lines hold NOW; when it does not match, nothing changes and you get the real lines back. replacement "" DELETES the lines.',
            parameters: {
                type: 'object',
                properties: {
                    start_line: { type: 'integer', description: 'First line of the range (1-based).' },
                    end_line: { type: 'integer', description: 'Last line of the range (inclusive).' },
                    expected_text: { type: 'string', description: 'The current text of those lines, without line numbers.' },
                    replacement: { type: 'string', description: 'The new lines. "" deletes the range.' },
                    summary: SUMMARY_PROP,
                },
                required: ['start_line', 'end_line', 'expected_text', 'replacement', 'summary'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'code_write',
            description: 'Replace the WHOLE code. Only when the editor is empty or when you rewrite most of it; for anything smaller use code_replace or code_patch, which keep what the person wrote.',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: 'The complete new code, without line numbers and without Markdown fences.' },
                    summary: SUMMARY_PROP,
                },
                required: ['code', 'summary'],
            },
        },
    },
];

const CODE_TOOL_NAMES = new Set(CODE_TOOLS.map(t => t.function.name));

// ── Line numbers ────────────────────────────────────────────────────

/** The code as the model reads it: `  12 | text`, numbered from `from`. */
function numberLines(code, { from = 1, to = null } = {}) {
    const lines = String(code || '').split('\n');
    const last = Math.min(lines.length, to || lines.length);
    const first = Math.max(1, from);
    const width = String(last).length;
    const out = [];
    for (let n = first; n <= last; n++) out.push(`${String(n).padStart(width)} | ${lines[n - 1]}`);
    return out.join('\n');
}

const NUMBER_PREFIX_RE = /^\s*\d+ \| ?/;

/**
 * Undo a listing's line numbers when EVERY non-empty line carries one: the
 * model copied from code_read. A single numbered-looking line is left alone
 * (it could be code); a whole block of them never is.
 */
function stripLineNumbers(text) {
    if (typeof text !== 'string' || !text) return text;
    const lines = text.split('\n');
    const nonEmpty = lines.filter(l => l.trim());
    if (!nonEmpty.length || !nonEmpty.every(l => NUMBER_PREFIX_RE.test(l))) return text;
    return lines.map(l => l.replace(NUMBER_PREFIX_RE, '')).join('\n');
}

/** A whole write wrapped in a Markdown fence loses the fence. */
function stripFence(text) {
    if (typeof text !== 'string') return text;
    const m = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text);
    return m ? m[1] : text;
}

// ── Where an edit landed ────────────────────────────────────────────

/**
 * The lines that differ between two versions, as a 1-based inclusive range in
 * the NEW text, or null when nothing changed. A pure deletion answers the line
 * where the text was (start === end).
 */
function changedLineRange(before, after) {
    if (before === after) return null;
    const a = String(before).split('\n');
    const b = String(after).split('\n');
    let top = 0;
    while (top < a.length && top < b.length && a[top] === b[top]) top++;
    let bottom = 0;
    while (bottom < a.length - top && bottom < b.length - top
        && a[a.length - 1 - bottom] === b[b.length - 1 - bottom]) bottom++;
    const lastLine = Math.max(1, b.length);
    const startLine = Math.min(top + 1, lastLine);
    const endLine = Math.min(Math.max(startLine, b.length - bottom), lastLine);
    return { startLine, endLine };
}

function excerpt(code, range) {
    const lines = String(code).split('\n').length;
    const from = Math.max(1, range.startLine - EXCERPT_CONTEXT_LINES);
    const to = Math.min(lines, range.endLine + EXCERPT_CONTEXT_LINES, from + EXCERPT_MAX_LINES - 1);
    return numberLines(code, { from, to });
}

function lineCount(code) {
    return String(code || '').split('\n').length;
}

// ── Fallback summaries (when the model gave none) ──────────────────

function fallbackSummary(op, range) {
    if (op === 'write') return { summary: 'Rewrote the code', summaryKey: 'code_step.assist.edit.write', summaryParams: {} };
    if (op === 'delete') {
        return { summary: `Removed code at line ${range.startLine}`, summaryKey: 'code_step.assist.edit.removed', summaryParams: { line: range.startLine } };
    }
    if (range.startLine === range.endLine) {
        return { summary: `Changed line ${range.startLine}`, summaryKey: 'code_step.assist.edit.changed_line', summaryParams: { line: range.startLine } };
    }
    return {
        summary: `Changed lines ${range.startLine}-${range.endLine}`,
        summaryKey: 'code_step.assist.edit.changed_lines',
        summaryParams: { start: range.startLine, end: range.endLine },
    };
}

function cleanSummary(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * The edit a tool made, as the client's `edit` event and the model's result.
 * `op` is what the tool did, with a replace or patch that only removed text
 * reported as 'delete'.
 */
function landed(tool, before, after, args, { removedOnly }) {
    const diff = changedLineRange(before, after);
    // A whole-code write replaced everything: the range is the new code, not
    // the lines that happen to differ from the old one.
    const range = diff && tool === 'code_write' ? { startLine: 1, endLine: Math.max(1, String(after).split('\n').length) } : diff;
    if (!range) {
        return { code: before, edit: null, result: { ok: true, message: 'Nothing changed: the new text is the same as the old.' } };
    }
    const op = tool === 'code_write' ? 'write' : (removedOnly ? 'delete' : (tool === 'code_patch' ? 'patch' : 'replace'));
    const given = cleanSummary(args && args.summary);
    const edit = {
        op,
        ...(given ? { summary: given } : fallbackSummary(op, range)),
        startLine: range.startLine,
        endLine: range.endLine,
    };
    const where = range.startLine === range.endLine ? `line ${range.startLine}` : `lines ${range.startLine}-${range.endLine}`;
    return {
        code: after,
        edit,
        result: {
            ok: true,
            message: `${op === 'delete' ? 'Removed the text at' : 'Changed'} ${where}. The code has ${lineCount(after)} lines now.`,
            around: excerpt(after, range),
        },
    };
}

// ── The tools ───────────────────────────────────────────────────────

function tooBig(after) {
    return after.length > MAX_CODE_CHARS
        ? { error: `The code would be ${after.length.toLocaleString('en')} characters; a code step holds at most ${MAX_CODE_CHARS.toLocaleString('en')}. Keep it smaller.` }
        : null;
}

function read(code, args) {
    const total = lineCount(code);
    if (!String(code || '').trim()) return { result: { content: '', message: 'The code is empty. Use code_write to create it.' } };
    const from = Number.isInteger(args.start_line) && args.start_line > 0 ? args.start_line : 1;
    const to = Number.isInteger(args.end_line) && args.end_line >= from ? Math.min(args.end_line, total) : total;
    return { result: { lines: `${from}-${to} of ${total}`, content: numberLines(code, { from, to }) } };
}

function replace(code, args) {
    if (typeof args.find_text !== 'string' || !args.find_text) return { result: { error: 'find_text is required: copy the exact text to change from the code.' } };
    const replaceText = typeof args.replace_text === 'string' ? args.replace_text : '';
    const opts = { replaceText, replaceAll: args.replace_all === true, label: 'the code', readHint: 'Call code_read' };
    let r = applyFindReplace(code, { ...opts, findText: args.find_text });
    // A find_text copied WITH its line numbers, retried without them. The
    // replacement is cleaned the same way only when it carries them too.
    if (r.error) {
        const bare = stripLineNumbers(args.find_text);
        if (bare !== args.find_text) {
            const retry = applyFindReplace(code, { ...opts, findText: bare, replaceText: stripLineNumbers(replaceText) });
            if (!retry.error) r = retry;
        }
    }
    if (r.error) return { result: { error: r.error } };
    const big = tooBig(r.content);
    if (big) return { result: big };
    return landed('code_replace', code, r.content, args, { removedOnly: replaceText === '' });
}

function patch(code, args) {
    const start = Number(args.start_line);
    const end = Number(args.end_line);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        return { result: { error: `start_line and end_line are 1-based whole numbers with start_line <= end_line (got ${args.start_line} and ${args.end_line}).` } };
    }
    const lines = String(code || '').split('\n');
    if (end > lines.length) {
        return { result: { error: `end_line ${end} is past the end of the code, which has ${lines.length} lines. Call code_read.` } };
    }
    const actual = lines.slice(start - 1, end).join('\n');
    const expected = stripLineNumbers(typeof args.expected_text === 'string' ? args.expected_text : '');
    if (normalizeWhitespace(actual) !== normalizeWhitespace(expected)) {
        return {
            result: {
                error: `expected_text does not match lines ${start}-${end}; nothing changed. Those lines are:\n${truncate(numberLines(code, { from: start, to: end }), 1200)}`,
            },
        };
    }
    const replacement = stripLineNumbers(typeof args.replacement === 'string' ? args.replacement : '');
    const next = [...lines.slice(0, start - 1), ...(replacement === '' ? [] : replacement.split('\n')), ...lines.slice(end)].join('\n');
    const big = tooBig(next);
    if (big) return { result: big };
    return landed('code_patch', code, next, args, { removedOnly: replacement === '' });
}

function write(code, args) {
    if (typeof args.code !== 'string') return { result: { error: 'code is required: the complete new code.' } };
    const next = stripLineNumbers(stripFence(args.code));
    const big = tooBig(next);
    if (big) return { result: big };
    return landed('code_write', code, next, args, { removedOnly: false });
}

/**
 * Run one tool call against `code`.
 *
 * @param {string} name   one of CODE_TOOL_NAMES
 * @param {object} args   the parsed arguments
 * @param {string} code   the code as it stands
 * @returns {{ code: string, edit: object|null, result: object }}
 *   `code` the code after the call (unchanged on a read or a refusal), `edit`
 *   the client's `edit` event or null, `result` what the model reads back.
 */
function executeCodeTool(name, args, code) {
    const a = args && typeof args === 'object' ? args : {};
    const current = typeof code === 'string' ? code : '';
    let out;
    if (name === 'code_read') out = read(current, a);
    else if (name === 'code_replace') out = replace(current, a);
    else if (name === 'code_patch') out = patch(current, a);
    else if (name === 'code_write') out = write(current, a);
    else out = { result: { error: `Unknown tool "${name}". The tools are ${[...CODE_TOOL_NAMES].join(', ')}.` } };
    return { code: typeof out.code === 'string' ? out.code : current, edit: out.edit || null, result: out.result };
}

module.exports = {
    CODE_TOOLS,
    CODE_TOOL_NAMES,
    MAX_CODE_CHARS,
    executeCodeTool,
    numberLines,
    stripLineNumbers,
    stripFence,
    changedLineRange,
};
