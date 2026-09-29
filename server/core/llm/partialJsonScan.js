// @typecheck
/**
 * Reading UNFINISHED JSON — the structural half of the live "tool draft"
 * visualisations. While a model streams a tool call, the adapter hands the
 * builders the arguments accumulated so far (`tool_args_delta`), cut at any
 * byte, often inside a string. This module walks braces and strings (with
 * escapes) into a light tree of objects/arrays with their string-valued keys;
 * each builder's own selector (routes/ai/<builder>/toolDraft.js) then reads
 * what it cares about off that tree.
 *
 * Deliberately NOT a JSON parser. Nothing here may throw — a caller wraps a
 * selector in try/catch and shows nothing — and nothing here is ever fed
 * back to the model or a definition; it is a visualisation.
 *
 * Also the two throttles both routes gate their SSE events with, with an
 * injectable clock so they can be tested without waiting.
 */

'use strict';

const MAX_LABEL = 80;

/**
 * Walk a (possibly truncated) JSON string into a tree:
 *   node = { kind: 'object'|'array', key, closed, strings: Map<key,{value,terminated}>,
 *            children: node[], elements: {value,terminated}[] }   // elements: string items of an array
 * `key` is the object key the node sits under in its parent (null for array
 * elements and the root). Only string scalars are recorded — numbers,
 * booleans and null carry nothing the visualisation needs.
 */
function scanStructure(src) {
    const text = String(src || '');
    let root = null;
    const stack = [];
    const top = () => stack[stack.length - 1];

    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        const cur = top();

        if (ch === '"') {
            const { value, end, terminated } = readString(text, i + 1);
            i = end;
            if (cur) {
                if (cur.kind === 'array') {
                    cur.elements.push({ value, terminated });
                } else if (cur.expectKey) {
                    // A key cut mid-way names nothing yet.
                    if (terminated) { cur.pendingKey = value; cur.expectKey = false; }
                } else if (cur.pendingKey !== null) {
                    cur.strings.set(cur.pendingKey, { value, terminated });
                    cur.pendingKey = null;
                }
            }
            continue;
        }

        if (ch === '{' || ch === '[') {
            const node = {
                kind: ch === '{' ? 'object' : 'array',
                key: cur && cur.kind === 'object' ? cur.pendingKey : null,
                closed: false,
                strings: new Map(),
                children: [],
                elements: [],
                // object-only cursor state
                expectKey: true,
                pendingKey: null,
            };
            if (cur) {
                cur.children.push(node);
                if (cur.kind === 'object') cur.pendingKey = null;
            } else if (!root) {
                root = node;
            }
            stack.push(node);
            i += 1;
            continue;
        }

        if (ch === '}' || ch === ']') {
            if (cur) { cur.closed = true; stack.pop(); }
            i += 1;
            continue;
        }

        if (cur && cur.kind === 'object') {
            if (ch === ':') cur.expectKey = false;
            else if (ch === ',') { cur.expectKey = true; cur.pendingKey = null; }
        }
        i += 1;
    }
    return root;
}

/** Read a JSON string body starting AFTER the opening quote; decodes the common escapes. */
function readString(text, start) {
    let out = '';
    let i = start;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === '"') return { value: out, end: i + 1, terminated: true };
        if (ch === '\\') {
            if (i + 1 >= n) break;                  // cut right after a backslash
            const esc = text[i + 1];
            if (esc === 'u') {
                const hex = text.slice(i + 2, i + 6);
                if (hex.length < 4) break;          // cut inside \uXXXX
                const code = parseInt(hex, 16);
                out += Number.isFinite(code) ? String.fromCharCode(code) : '';
                i += 6;
            } else {
                out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r'
                    : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;   // \" \\ \/ and unknown → the char itself
                i += 2;
            }
            continue;
        }
        out += ch;
        i += 1;
    }
    return { value: out, end: n, terminated: false };
}

// ─── tree helpers ────────────────────────────────────────────────────────────

const childObject = (node, key) => node && node.children.find(c => c.kind === 'object' && c.key === key) || null;
const childArray = (node, key) => node && node.children.find(c => c.kind === 'array' && c.key === key) || null;
const firstArray = (node) => node && node.children.find(c => c.kind === 'array') || null;
const objectElements = (arr) => arr ? arr.children.filter(c => c.kind === 'object') : [];

/** The first string value under any of `keys`, or null. `any` also returns unterminated text. */
function pick(nodes, keys, { any = false } = {}) {
    for (const node of nodes) {
        if (!node) continue;
        for (const key of keys) {
            const s = node.strings.get(key);
            if (s && (any || s.terminated)) return s;
        }
    }
    return null;
}

const cleanLabel = (s) => {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, MAX_LABEL) : null;
};

/**
 * Gate for `tool_draft`: at most one emit per `intervalMs`, plus one at once
 * whenever the key changes. Returns `shouldEmit(key) → boolean`.
 */
function makeDraftThrottle({ now = Date.now, intervalMs = 250 } = {}) {
    let lastAt = -Infinity;
    let lastKey = undefined;
    return function shouldEmit(key) {
        const t = now();
        if (key !== lastKey || t - lastAt >= intervalMs) {
            lastAt = t;
            lastKey = key;
            return true;
        }
        return false;
    };
}

/**
 * Gate for `prompt_progress`: at most one emit per `intervalMs` (≈4/s), except
 * that `shouldEmit(true)` always passes — the chunk that says the prefill is
 * complete must not be the one the throttle swallows.
 */
function makeProgressThrottle({ now = Date.now, intervalMs = 250 } = {}) {
    let lastAt = -Infinity;
    return function shouldEmit(force = false) {
        const t = now();
        if (force || t - lastAt >= intervalMs) {
            lastAt = t;
            return true;
        }
        return false;
    };
}

// A string value carrying JSON punctuation followed by another key is the
// signature of a batch whose JSON arrived corrupted mid-way — seen as a
// field type of "string}}},systemPrompt:" that swallowed the rest of its
// entry, leaving the entry with no `type`. A plain {{template}} never has
// three closing braces or a `},key:` run, so ordinary prompts stay clean.
// The second alternative is the tool-call wire syntax itself (Gemma's
// `<|tool_call>` / `<tool_call|>`, Hermes' `<tool_call>`): a string value
// that swallowed the NEXT call's opening marker — recorded 2026-09-13 as
// `type: "text}]}}]}<tool_call|><|tool_call>call:app_set_action{action:{kind:"`
// — has neither `}}}` nor a `},key:` run, so the first alternative misses
// it. A control token never belongs inside a legitimate string value.
const GARBLED_RX = /\}\}\}|[}\]]\s*,\s*"?[A-Za-z_][A-Za-z0-9_]*"?\s*:|<\|tool_call>|<tool_call\|>|<\/?tool_call>/;
function looksGarbled(v, depth = 0) {
    if (depth > 6 || v === null || v === undefined) return false;
    if (typeof v === 'string') return GARBLED_RX.test(v);
    if (Array.isArray(v)) return v.some(x => looksGarbled(x, depth + 1));
    if (typeof v === 'object') return Object.values(v).some(x => looksGarbled(x, depth + 1));
    return false;
}

module.exports = {
    MAX_LABEL,
    looksGarbled,
    scanStructure,
    readString,
    childObject,
    childArray,
    firstArray,
    objectElements,
    pick,
    cleanLabel,
    makeDraftThrottle,
    makeProgressThrottle,
};
