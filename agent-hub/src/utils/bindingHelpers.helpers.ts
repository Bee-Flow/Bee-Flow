import { compile } from '@shared/expr/engine.mjs';
import { formatPath, getRelativePath, parsePath, scanTemplate } from '@shared/expr/path.mjs';
import type { AstNode, BindingInput, PathToken } from './bindingHelpers.types';

// The same head, for splitting it off: the id is one key, the rest is a path tail.
const INLINE_HEAD_RE = /^steps\.([A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)+)(?=$|[.[])/;

const VALID_REF_ROOTS: (string | number | undefined)[] = ['trigger', 'steps', 'vars', 'secrets', 'loop'];

// A path the author can mean starts like a name. The grammar also reads `42`
// or `-x` as a key, but as typed text those are a number and a formula.
const NAME_START_RE = /^[\p{L}_$]/u;

/** Tokens of a path TAIL (`.a["b"]`, `[0].x`, ``), or null when it does not continue a path. */
export function tailTokens(rest: string): PathToken[] | null {
    if (!rest) return [];
    if (rest[0] !== '.' && rest[0] !== '[') return null;
    const t = parsePath(`$${rest}`);
    return t ? t.slice(1) : null;
}

/**
 * The tokens of a path the builder may hold, or null: the shared grammar,
 * plus the builder-only flowlet sub-step id (`steps.<call>/<sub>`), which is
 * one key whose `/` no runtime grammar reads.
 */
export function anyPathTokens(text: unknown): PathToken[] | null {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    const inline = INLINE_HEAD_RE.exec(t);
    if (inline) {
        const tail = tailTokens(t.slice(inline[0].length));
        return tail ? [{ type: 'prop', key: 'steps' }, { type: 'prop', key: inline[1] as string }, ...tail] : null;
    }
    return parsePath(t);
}

/** The tokens of a reference path an author typed or picked, or null. */
export function refPathTokens(text: unknown): PathToken[] | null {
    if (typeof text !== 'string' || !NAME_START_RE.test(text.trim())) return null;
    return anyPathTokens(text);
}

/**
 * The canonical spelling of a reference path (`.ident`, `[0]`, `["odd key"]`,
 * JSON-escaped) — what every insertion writes, and what the expression engine
 * reads as the same path. Text that is not a path comes back trimmed.
 */
export function canonicalRefPath(text: unknown): string {
    const t = String(text ?? '').trim();
    const tokens = anyPathTokens(t);
    if (!tokens) return t;
    const inline = INLINE_HEAD_RE.exec(t);
    if (inline) return `${inline[0]}${formatPath([{ type: 'prop', key: '$' }, ...tokens.slice(2)] as never).slice(1)}`;
    return formatPath(tokens as never);
}

/** A `-` outside quotes and brackets: the one name character that is also an operator. */
function dashInName(t: string): boolean {
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '-' && depth === 0) return true;
    }
    return false;
}

/**
 * Does a dashed path read as a SUBTRACTION someone meant? `total-1` and
 * `a.total-b.tax` do (a number, or another path, after the minus);
 * `headers.content-type` and `x-request-id` do not (a lone word is a key
 * fragment, not an operand anyone subtracts).
 */
function readsAsArithmetic(t: string): boolean {
    if (!dashInName(t)) return false;
    let ast;
    try { ast = compile(t).ast; } catch { return false; }
    const operand = (n?: AstNode | null) => n?.kind === 'num' || (n?.kind === 'path' && (n.segments as unknown[]).length > 1);
    const walk = (n?: AstNode | null): boolean => !!n && typeof n === 'object' && (
        (n.kind === 'binop' && n.op === '-' && operand(n.b)) || walk(n.a) || walk(n.b)
    );
    return walk(ast);
}

/**
 * Does a `{{ … }}` placeholder exist in the text? Quote-aware, exactly as
 * the runtime scans (shared/expr/path.mjs scanTemplate): `{{ x["a}b"] }}`
 * is one placeholder, `{{ }}` is none.
 */
export function detectTemplate(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    return scanTemplate(text).some((p: { type: string }) => p.type === 'ref');
}

/**
 * Is this text one whole path (`steps.s1.output.foo`, `loop.item["Story
 * Points"]`, `x.list[*].id`, `headers[name="Subject"].value`) — no operators?
 * A dashed name that reads as a subtraction (`total-1`) is a formula.
 */
export function isCleanPath(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    const t = text.trim();
    if (!refPathTokens(t)) return false;
    return !readsAsArithmetic(t);
}

/**
 * Pick the most appropriate binding kind for the user's typed value
 * given the current "mode". Mode is the user-facing toggle:
 *   - 'fixed'      — a literal text value, OR a template if it contains {{...}}
 *   - 'expression' — a ref (clean path) or a JS expression
 *
 * A ref is stored in its canonical spelling: whatever later turns it into a
 * template, a condition or a `join(…)` call then writes something every
 * reader of the definition resolves the same way.
 *
 * Returns a canonical binding object the runtime resolver accepts.
 */
export function bindingFromInput(value: unknown, mode: string) {
    if (mode === 'expression') {
        const v = String(value ?? '').trim();
        if (!v) return { kind: 'literal', value: '' };
        const tokens = isCleanPath(v) ? refPathTokens(v) : null;
        if (tokens && VALID_REF_ROOTS.includes((tokens[0] as { key?: string }).key as string)) {
            return { kind: 'ref', path: canonicalRefPath(v) };
        }
        return { kind: 'expr', value: v };
    }
    // fixed mode
    if (detectTemplate(value)) return { kind: 'template', value: String(value) };
    return { kind: 'literal', value: value ?? '' };
}

// Keys that only say "the value of it". After a match segment the matched
// value is the name: `headers[name="Subject"].value` is the Subject header.
const GENERIC_VALUE_KEYS = new Set<string | undefined>(['value', 'Value', 'val', 'content', 'text']);

/** The name a token list ends in: the last real key, skipping `[*]` and indexes. */
export function leafOf(tokens: PathToken[]): string {
    for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i] as PathToken;
        if (t.type === 'wild') continue;
        if (t.type === 'match') return t.value === null ? 'null' : String(t.value);
        if (typeof t.key === 'number') continue;
        const prev = tokens[i - 1];
        if (GENERIC_VALUE_KEYS.has(t.key) && prev?.type === 'match') return prev.value === null ? 'null' : String(prev.value);
        return t.key as string;
    }
    return '';
}

// Leaf keys that name nothing on their own: two pills reading "▸ Address"
// (a sender's and a cc's) would look identical, so the label adds the key
// that says WHOSE address it is.
const GENERIC_LEAF_KEYS = new Set<string>(['address', 'name', 'id', 'value', 'email', 'type']);

const squash = (k: unknown) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

export const isIndexOrWild = (tok: PathToken) => tok.type === 'wild' || (tok.type === 'prop' && typeof tok.key === 'number');

/** For a generic leaf, the nearest key above it that says whose it is ('' when none). */
export function parentOf(tokens: PathToken[], at: number, leaf: string): string {
    if (!GENERIC_LEAF_KEYS.has(squash(leaf))) return '';
    for (let i = at - 1; i >= 0; i--) {
        const k = tokens[i] as PathToken;
        if (k.type !== 'prop' || typeof k.key !== 'string') continue;
        const s = squash(k.key);
        if (!s || GENERIC_LEAF_KEYS.has(s) || s.includes(squash(leaf))) continue;
        return k.key;
    }
    return '';
}

export function findOperator(text: string, op: string): number {
    let from = 0;
    while (from < text.length) {
        const idx = text.indexOf(op, from);
        if (idx === -1) return -1;
        // Inside a quoted key (`fields["a > b"]`) or a string literal an
        // operator character is text, not an operator.
        if (insideQuotes(text, idx)) {
            from = idx + 1;
            continue;
        }
        const before = (idx > 0 ? text[idx - 1] : ' ') as string;
        const after = (idx + op.length < text.length ? text[idx + op.length] : ' ') as string;
        // Reject if surrounded by other operator chars (avoids splitting `>=` on `>`).
        const opChars = new Set(['=', '!', '<', '>']);
        if (opChars.has(before) || opChars.has(after)) {
            from = idx + 1;
            continue;
        }
        return idx;
    }
    return -1;
}

/** Is position `at` inside a quoted string of `text`? */
function insideQuotes(text: string, at: number): boolean {
    let quote: string | null = null;
    for (let i = 0; i < at; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
            quote = c;
        }
    }
    return quote !== null;
}

/**
 * Build a raw expression string from the visual Condition builder's
 * three slots. `rightBinding` may be a literal (rendered as JSON) or
 * a ref/expr (rendered as the bare path / expression).
 */
export function buildConditionExpr(leftPath: unknown, op: string, rightBinding: BindingInput): string {
    const left = String(leftPath || '').trim();
    if (!left) return '';
    const right = renderBindingValue(rightBinding);
    return `${left} ${op} ${right}`;
}

/**
 * Render a binding as the right-hand side of a restricted-JS expression:
 * literals as JSON, refs as the bare path, exprs verbatim. Shared by the
 * condition/filter builders so every comparison serialises identically.
 */
export function renderBindingValue(b: BindingInput): string {
    if (!b || typeof b !== 'object') return JSON.stringify(b ?? '');
    // `?? ''` here meant an EXPLICIT null rendered as the empty string, so the
    // condition builder rewrote `form.assignee == null` into
    // `form.assignee == ""` the moment any row in the group was edited — "show
    // this only when nobody is assigned" quietly became "…when the assignee is
    // an empty string", which is a different question with a different answer.
    // Only `undefined` means "nothing filled in yet"; parseExprToRows produces
    // value:null solely from a literal `null` the author actually wrote.
    if (b.kind === 'literal') return JSON.stringify(b.value === undefined ? '' : b.value);
    if (b.kind === 'ref')     return String(b.path || '');
    if (b.kind === 'expr')    return String(b.value || '');
    if (b.kind === 'template') return templateToExprFragment(String(b.value || ''));
    return JSON.stringify(b);
}

/**
 * Render a `template` binding as an EXPRESSION fragment.
 *
 * This used to be `JSON.stringify(b.value)`, which turned the raw,
 * uninterpolated template text into a string LITERAL: picking a variable in
 * the condition builder's default "fixed" mode (BindingField inserts
 * `{{path}}` there, and bindingFromInput promotes that to kind 'template')
 * saved
 *     steps.s1.output.status == "{{trigger.output.status}}"
 * — an expression that is false for every run, silently, with a green status.
 * Nothing interpolates inside an `expr`; only the binding resolver does that.
 *
 * So a template that is ONE whole-string interpolation collapses to its bare
 * path — the same rule BindingField.translateForMode uses when the user flips
 * the mode switch. Mixed literal+interpolation text becomes `concat(...)` of
 * quoted literal runs and bare paths (`concat` is on the engine's whitelist),
 * which is what the template MEANT. Anything whose interpolation isn't a clean
 * path (e.g. `{{a + 1}}`) keeps the historical quoted-raw-string rendering
 * rather than emitting something the restricted grammar can't parse.
 */
function templateToExprFragment(text: string): string {
    const parts: string[] = [];
    let sawPath = false;
    // The runtime's own placeholder scan (quote-aware), and the runtime's own
    // path grammar for what is inside: the template resolves `{{ a.content-type }}`
    // as a key, so the expression gets the CANONICAL spelling
    // (`a["content-type"]`), which the engine reads as that same key rather
    // than as a subtraction.
    for (const p of scanTemplate(text)) {
        if (p.type === 'text') { parts.push(JSON.stringify(p.value)); continue; }
        if (!refPathTokens(p.inner)) return JSON.stringify(text);
        parts.push(canonicalRefPath(p.inner));
        sawPath = true;
    }
    if (!sawPath) return JSON.stringify(text);
    return parts.length === 1 ? (parts[0] as string) : `concat(${parts.join(', ')})`;
}

/**
 * Walk a path RELATIVE to an arbitrary value (not the runState roots) — the
 * runtime's own getRelativePath (server/automation/bind.js walkRelativePath),
 * used by the parse_json step editor's live preview so what the user sees is
 * exactly what the runtime extracts. `''`/`'$'`/nullish returns the whole
 * source; `[0].x`, `[*].sku` and `$.a` start at a root list or object.
 */
export function walkRelativePath(path: unknown, value: unknown) {
    return getRelativePath(value, path);
}
