/**
 * Helpers for the mapping/binding UX. The runtime accepts four binding
 * kinds — literal, ref, template, expr — but the user-facing UI hides
 * the kind behind a simpler "fixed vs expression" toggle and detects
 * the right kind automatically when the user types `{{...}}` or a
 * clean path. Every function here is pure and side-effect free except
 * `insertAtCursor` which mutates a DOM input/textarea.
 *
 * Paths are read and written with the ONE grammar the run resolves
 * (shared/expr/path.mjs): `["Story Points"]`, `[0]`, `[*]`, `[-1]`,
 * `[name="Subject"]`, unicode and `content-type` all mean here exactly what
 * they mean to server/automation/bind.js. This module used to carry its own
 * identifier-only regex and a laxer walker, so a quoted key was stored as a
 * formula, flipped to Text as its own path text, and previewed values the run
 * never got. Reading accepts every spelling the runtime accepts; writing
 * (`formatPathForInsert`, `canonicalRefPath`) always produces the canonical
 * spelling, which the expression engine reads too.
 */
import { compile } from '@shared/expr/engine.mjs';
import { formatPath, getRelativePath, parsePath, scanTemplate, walkTokens } from '@shared/expr/path.mjs';

// A cheap "might hold {{…}}" probe, kept for older callers. It cannot see a
// placeholder whose quoted key holds a brace; `detectTemplate` can.
export const TEMPLATE_RE = /\{\{[^}]+\}\}/;
// A sub-step of an expanded flowlet: `steps.<callId>/<subId>.output…` (the
// prefix is stripped on save — flow/inlineFlowlets.js). The `/` is allowed
// ONLY inside that step id, so `steps.a.output.total/2` stays a formula.
export const INLINE_STEP_PATH_RE = /^steps\.[A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)+(?:\.[\w$]+|\[[^\]]*\])*$/;
// The same head, for splitting it off: the id is one key, the rest is an
// ordinary path tail.
const INLINE_HEAD_RE = /^steps\.([A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)+)(?=$|[.[])/;
const VALID_REF_ROOTS = ['trigger', 'steps', 'vars', 'secrets', 'loop'];
// A path the author can mean starts like a name. The grammar also reads `42`
// or `-x` as a key, but as typed text those are a number and a formula.
const NAME_START_RE = /^[\p{L}_$]/u;

/** Tokens of a path TAIL (`.a["b"]`, `[0].x`, ``), or null when it does not continue a path. */
function tailTokens(rest) {
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
function anyPathTokens(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    const inline = INLINE_HEAD_RE.exec(t);
    if (inline) {
        const tail = tailTokens(t.slice(inline[0].length));
        return tail ? [{ type: 'prop', key: 'steps' }, { type: 'prop', key: inline[1] }, ...tail] : null;
    }
    return parsePath(t);
}

/** The tokens of a reference path an author typed or picked, or null. */
export function refPathTokens(text) {
    if (typeof text !== 'string' || !NAME_START_RE.test(text.trim())) return null;
    return anyPathTokens(text);
}

/**
 * The canonical spelling of a reference path (`.ident`, `[0]`, `["odd key"]`,
 * JSON-escaped) — what every insertion writes, and what the expression engine
 * reads as the same path. Text that is not a path comes back trimmed.
 */
export function canonicalRefPath(text) {
    const t = String(text ?? '').trim();
    const tokens = anyPathTokens(t);
    if (!tokens) return t;
    const inline = INLINE_HEAD_RE.exec(t);
    if (inline) return `${inline[0]}${formatPath([{ type: 'prop', key: '$' }, ...tokens.slice(2)]).slice(1)}`;
    return formatPath(tokens);
}

/** A `-` outside quotes and brackets: the one name character that is also an operator. */
function dashInName(t) {
    let depth = 0;
    let quote = null;
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
function readsAsArithmetic(t) {
    if (!dashInName(t)) return false;
    let ast;
    try { ast = compile(t).ast; } catch { return false; }
    const operand = (n) => n?.kind === 'num' || (n?.kind === 'path' && n.segments.length > 1);
    const walk = (n) => !!n && typeof n === 'object' && (
        (n.kind === 'binop' && n.op === '-' && operand(n.b)) || walk(n.a) || walk(n.b)
    );
    return walk(ast);
}

/**
 * Does a `{{ … }}` placeholder exist in the text? Quote-aware, exactly as
 * the runtime scans (shared/expr/path.mjs scanTemplate): `{{ x["a}b"] }}`
 * is one placeholder, `{{ }}` is none.
 */
export function detectTemplate(text) {
    if (typeof text !== 'string') return false;
    return scanTemplate(text).some(p => p.type === 'ref');
}

/**
 * Is this text one whole path (`steps.s1.output.foo`, `loop.item["Story
 * Points"]`, `x.list[*].id`, `headers[name="Subject"].value`) — no operators?
 * A dashed name that reads as a subtraction (`total-1`) is a formula.
 */
export function isCleanPath(text) {
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
export function bindingFromInput(value, mode) {
    if (mode === 'expression') {
        const v = String(value ?? '').trim();
        if (!v) return { kind: 'literal', value: '' };
        const tokens = isCleanPath(v) ? refPathTokens(v) : null;
        if (tokens && VALID_REF_ROOTS.includes(tokens[0].key)) {
            return { kind: 'ref', path: canonicalRefPath(v) };
        }
        return { kind: 'expr', value: v };
    }
    // fixed mode
    if (detectTemplate(value)) return { kind: 'template', value: String(value) };
    return { kind: 'literal', value: value ?? '' };
}

const BINDING_KINDS = new Set(['literal', 'ref', 'template', 'expr']);

/**
 * A value the text editor can only show as JSON: a bare map of bindings (the
 * shape canonicalizeBinding emits for an object parameter), an array, or an
 * object/array literal. The runtime resolves each of these as a STRUCTURE
 * (bind.js resolveDeep), so turning the edited text into a string would hand
 * the tool binding descriptors instead of values.
 */
export function isStructuredBinding(b) {
    if (b == null || typeof b !== 'object') return false;
    if (Array.isArray(b)) return true;
    if (BINDING_KINDS.has(b.kind)) return b.kind === 'literal' && b.value !== null && typeof b.value === 'object';
    return true;
}

/**
 * Edited JSON text back into the SHAPE of the structured value it was opened
 * from (a literal stays a literal around the parsed value, a bare map stays a
 * bare map, nested {kind} wrappers intact). Null while the text is not a JSON
 * object or array — the caller keeps the old value rather than saving a string.
 */
export function structuredFromText(text, original) {
    let parsed;
    try { parsed = JSON.parse(String(text ?? '')); } catch { return null; }
    if (parsed === null || typeof parsed !== 'object') return null;
    if (original && typeof original === 'object' && !Array.isArray(original) && original.kind === 'literal') {
        return { kind: 'literal', value: parsed };
    }
    return parsed;
}

/**
 * Inverse of bindingFromInput — given a stored binding, return the
 * `{ mode, text }` the input should display so the user can edit it
 * round-trip without losing meaning.
 *
 * Bare/unknown values are treated as fixed-mode literals (matches the
 * runtime resolver's tolerance — see canonicalizeBinding in
 * server/automation/builderTools.js).
 */
export function inputFromBinding(binding) {
    if (binding == null) return { mode: 'fixed', text: '' };
    if (typeof binding !== 'object') {
        return { mode: 'fixed', text: String(binding) };
    }
    if (binding.kind === 'literal') {
        const v = binding.value;
        if (v == null) return { mode: 'fixed', text: '' };
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            return { mode: 'fixed', text: String(v) };
        }
        // Object/array literal — show JSON in fixed mode (rare).
        try { return { mode: 'fixed', text: JSON.stringify(v) }; }
        catch (_) { return { mode: 'fixed', text: '' }; }
    }
    if (binding.kind === 'template') return { mode: 'fixed', text: String(binding.value || '') };
    if (binding.kind === 'ref')      return { mode: 'expression', text: String(binding.path || '') };
    if (binding.kind === 'expr')     return { mode: 'expression', text: String(binding.value || '') };
    // Unknown shape — treat as JSON literal so user can at least see it.
    try { return { mode: 'fixed', text: JSON.stringify(binding) }; }
    catch (_) { return { mode: 'fixed', text: '' }; }
}

/**
 * Insert text at the input/textarea's caret position, keeping focus and
 * positioning the caret right after the inserted snippet. Falls back to
 * appending if the element doesn't expose a selection API.
 *
 * Returns the resulting full value so the caller can lift it into React
 * state in the same tick (uncontrolled DOM mutation alone won't trigger
 * React's onChange).
 */
export function insertAtCursor(el, snippet) {
    if (!el) return null;
    const isTextLike = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    if (!isTextLike) return null;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const next = before + snippet + after;
    el.value = next;
    const caret = start + snippet.length;
    try { el.setSelectionRange(caret, caret); } catch (_) { /* ignore */ }
    el.focus();
    return next;
}

/**
 * Detect an in-progress variable token at the caret, to trigger the inline
 * autocomplete picker while typing.
 *   - mode 'fixed' (templates): an UNCLOSED `{{` before the caret with a
 *     path-ish partial → the token spans from the `{{` to the caret.
 *   - mode 'expression'/path: a partial rooted path (`steps.` / `trigger.` /
 *     `loop.` / `item.` / `vars.`) ending at the caret.
 * `roots` overrides which roots count — App Studio's scope shares none of the
 * automation roots but `item`/`vars` (see AUTOCOMPLETE_ROOTS).
 * Returns `{ start, end, query }` (range in el.value) or null.
 */
export function getAutocompleteToken(el, mode, roots = AUTOCOMPLETE_ROOTS) {
    if (!el || typeof el.value !== 'string') return null;
    const caret = el.selectionStart ?? el.value.length;
    const hit = getAutocompleteTokenFromPrefix(el.value.slice(0, caret), mode, roots);
    return hit ? { start: caret - hit.length, end: caret, query: hit.query } : null;
}

/**
 * The same rule, expressed over just the text BEFORE the caret — which is all a
 * contenteditable can offer (RefTokenInput has no selectionStart, and the pills
 * before the caret are not text at all). Returns `{ length, query }`, where
 * `length` is how many typed characters the accepted suggestion should swallow.
 */
export function getAutocompleteTokenFromPrefix(before, mode, roots = AUTOCOMPLETE_ROOTS) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a constant character class with one * on a slice after the last {{: linear
    const text = typeof before === 'string' ? before : '';
    if (mode === 'fixed') {
        const open = text.lastIndexOf('{{');
        if (open === -1) return null;
        const partial = text.slice(open + 2);
        if (partial.includes('}') || partial.includes('{')) return null;
        if (!/^[\w$.[\]*\s]*$/.test(partial)) return null;
        return { length: text.length - open, query: partial.trim() };
    }
    const list = safeRoots(roots);
    if (!list.length) return null;
    // Built from `list` rather than written out, so a caller with a different
    // scope (App Studio: currentUser/form/screen/actions/…) completes ITS roots
    // instead of the automation builder's.
    const rooted = new RegExp(`(?:^|[^\\w$.])((?:${list.join('|')})\\.[\\w$.[\\]*]*)$`);
    const m = rooted.exec(text);
    if (m) return { length: m[1].length, query: m[1] };
    // A bare partial that could still BECOME a root ("st", "trig", "steps").
    // Without this the picker only ever opened once a full root plus its dot
    // was already typed, so typing "st" suggested nothing and the feature read
    // as broken (BFSF-321). Restricted to prefixes of an actual root, and to
    // 2+ characters, so ordinary expression text doesn't pop the picker open on
    // every keystroke.
    const bare = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/.exec(text);
    if (!bare) return null;
    const partial = bare[1];
    if (partial.length < 2) return null;
    const lower = partial.toLowerCase();
    if (!list.some(root => root.toLowerCase().startsWith(lower))) return null;
    return { length: partial.length, query: partial };
}

// Roots the expression-mode picker will complete. Superset of VALID_REF_ROOTS:
// `item` is the conventional loop-body alias and is accepted by the runtime
// resolver, so users expect it to autocomplete too.
export const AUTOCOMPLETE_ROOTS = ['steps', 'trigger', 'loop', 'item', 'vars'];

/**
 * Keep only roots that are plain identifiers, so a caller-supplied list (in
 * App Studio's case, one fetched from the server catalog) can never smuggle
 * regex metacharacters into the pattern built above.
 */
function safeRoots(roots) {
    const list = Array.isArray(roots) ? roots : AUTOCOMPLETE_ROOTS;
    return list.filter(r => typeof r === 'string' && /^[A-Za-z_$][\w$]*$/.test(r));
}

/**
 * Replace [start, end) of the element's value with `snippet`, placing the
 * caret after it. Sibling of insertAtCursor for token-replacement (the
 * range was recorded when autocomplete opened — focus may have moved to
 * the picker's search box since). Returns the new full value.
 */
export function replaceRange(el, start, end, snippet) {
    if (!el) return null;
    const value = String(el.value ?? '');
    const from = Math.max(0, Math.min(start, value.length));
    const to = Math.max(from, Math.min(end, value.length));
    const next = value.slice(0, from) + snippet + value.slice(to);
    el.value = next;
    const caret = from + snippet.length;
    try { el.setSelectionRange(caret, caret); } catch (_) { /* ignore */ }
    el.focus();
    return next;
}

/**
 * Suggest a field NAME from a picked path — the last meaningful segment
 * (`trigger.output.subject` → `subject`). Used by the Set editor's
 * "Add field from a previous step" action.
 */
export function suggestKeyFromPath(path) {
    const tokens = anyPathTokens(String(path || ''));
    let seg = '';
    if (tokens) {
        // Read the KEYS, not the spelling: `fields["Story Points"]` names
        // "Story Points", and `headers[name="Subject"].value` names "Subject".
        seg = leafOf(tokens);
        if (seg === 'output' && tokens.length > 1) seg = leafOf(tokens.slice(0, -1));
    } else {
        const segs = String(path || '').trim().replace(/\[(?:\*|\d+)\]/g, '').split('.').filter(Boolean);
        seg = segs.pop() || '';
        if (seg === 'output' && segs.length) seg = segs.pop();
    }
    const key = String(seg).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    return key || 'field';
}

// Keys that only say "the value of it". After a match segment the matched
// value is the name: `headers[name="Subject"].value` is the Subject header.
const GENERIC_VALUE_KEYS = new Set(['value', 'Value', 'val', 'content', 'text']);

/** The name a token list ends in: the last real key, skipping `[*]` and indexes. */
function leafOf(tokens) {
    for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i];
        if (t.type === 'wild') continue;
        if (t.type === 'match') return t.value === null ? 'null' : String(t.value);
        if (typeof t.key === 'number') continue;
        const prev = tokens[i - 1];
        if (GENERIC_VALUE_KEYS.has(t.key) && prev?.type === 'match') return prev.value === null ? 'null' : String(prev.value);
        return t.key;
    }
    return '';
}

/**
 * The key a path (or a path TAIL such as a pill's field part, `["a b"].c`)
 * is named after, unquoted: `fields["Story Points"]` → "Story Points",
 * `items[0]` → "items", `headers[name="Subject"].value` → "Subject". '' when
 * there is none.
 */
export function pathLeafKey(pathOrTail) {
    const t = String(pathOrTail ?? '').trim();
    if (!t) return '';
    const tokens = t[0] === '[' ? tailTokens(t) : anyPathTokens(t);
    return tokens ? leafOf(tokens) : '';
}

// Leaf keys that name nothing on their own: two pills reading "▸ Address"
// (a sender's and a cc's) would look identical, so the label adds the key
// that says WHOSE address it is.
const GENERIC_LEAF_KEYS = new Set(['address', 'name', 'id', 'value', 'email', 'type']);
const squash = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What a pill or chip is named after, read from the path's keys:
 *   leaf    the key itself (`fields["Story Points"]` → "Story Points"; after
 *           a match segment its value: `headers[name="Subject"].value` →
 *           "Subject")
 *   parent  for a generic leaf only, the nearest key above it that says
 *           whose it is — `from.emailAddress.address` → "from" (emailAddress
 *           only repeats the leaf), `ccRecipients[*].emailAddress.address` →
 *           "ccRecipients"; '' when there is none
 *   index   an index right after the leaf (`items[0]` → 0, `[-1]` → -1), or null
 * Null when the text is not a path.
 */
export function pathLabelParts(pathOrTail) {
    const t = String(pathOrTail ?? '').trim();
    if (!t) return null;
    const tokens = t[0] === '[' ? tailTokens(t) : anyPathTokens(t);
    if (!tokens) return null;
    const leaf = leafOf(tokens);
    // Where the leaf sits: the last key that is not an index or a wildcard.
    let at = tokens.length - 1;
    while (at >= 0 && isIndexOrWild(tokens[at])) at--;
    const after = tokens.slice(at + 1).find(x => x.type === 'prop' && typeof x.key === 'number');
    return { leaf, parent: parentOf(tokens, at, leaf), index: after ? after.key : null };
}

const isIndexOrWild = (tok) => tok.type === 'wild' || (tok.type === 'prop' && typeof tok.key === 'number');

/** For a generic leaf, the nearest key above it that says whose it is ('' when none). */
function parentOf(tokens, at, leaf) {
    if (!GENERIC_LEAF_KEYS.has(squash(leaf))) return '';
    for (let i = at - 1; i >= 0; i--) {
        const k = tokens[i];
        if (k.type !== 'prop' || typeof k.key !== 'string') continue;
        const s = squash(k.key);
        if (!s || GENERIC_LEAF_KEYS.has(s) || s.includes(squash(leaf))) continue;
        return k.key;
    }
    return '';
}

/**
 * Format a path for insertion given the current field mode.
 *   - 'fixed'      — wrap as `{{path}}` so the runtime interpolates it
 *   - 'expression' — bare path (the field will detect ref vs expr)
 */
export function formatPathForInsert(path, mode) {
    const cleaned = String(path || '').trim();
    if (!cleaned) return '';
    // Canonical, whatever spelling the source handed over: a drag from an
    // output table may say `headers.content-type`, which a template resolves
    // but a formula reads as a subtraction.
    const canonical = canonicalRefPath(cleaned);
    if (mode === 'fixed') return `{{${canonical}}}`;
    return canonical;
}

/**
 * Try to break a raw expression like `steps.s1.output.total > 1000`
 * into `{ leftPath, op, rightValue }` for the visual Condition builder.
 * Returns null when the expression doesn't fit the simple
 * `<path> <op> <literal-or-path>` template (the visual mode falls back
 * to "advanced raw" in that case).
 *
 * Supported operators (textual, in order of length so longer alternatives
 * don't get shadowed by shorter ones):
 *   ===, !==, ==, !=, >=, <=, >, <
 */
const COND_OPS = ['===', '!==', '==', '!=', '>=', '<=', '>', '<'];

export function parseSimpleCondition(expr) {
    if (typeof expr !== 'string') return null;
    const text = expr.trim();
    if (!text) return null;
    for (const op of COND_OPS) {
        // Find an operator with whitespace on at least one side so we
        // don't match `>=` inside a longer token.
        const idx = findOperator(text, op);
        if (idx === -1) continue;
        const left = text.slice(0, idx).trim();
        const right = text.slice(idx + op.length).trim();
        if (!left || !right) continue;
        if (!isCleanPath(left)) return null;
        return { leftPath: left, op, rightRaw: right };
    }
    return null;
}

function findOperator(text, op) {
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
        const before = idx > 0 ? text[idx - 1] : ' ';
        const after = idx + op.length < text.length ? text[idx + op.length] : ' ';
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
function insideQuotes(text, at) {
    let quote = null;
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
export function buildConditionExpr(leftPath, op, rightBinding) {
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
export function renderBindingValue(b) {
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
function templateToExprFragment(text) {
    const parts = [];
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
    return parts.length === 1 ? parts[0] : `concat(${parts.join(', ')})`;
}

/**
 * Walk a dotted/bracketed path on an object
 * (`steps.s1.output.results[0].subject`, `…results[*].output.field`,
 * `obj["quoted key"]`, `headers[name="Subject"].value`). Returns undefined if
 * any segment is missing — never throws.
 *
 * This IS the runtime's walker (shared/expr/path.mjs, which
 * server/automation/bind.js walkPath delegates to): same grammar, JSON text
 * read as the value it encodes, the same `[*]` rules. The builder used to
 * carry a laxer copy that previewed `fields.Story Points` or `value[0x1]` —
 * values the run never got — so every preview here (VariableTree, the example
 * lines, list counts) now shows exactly what the run will see. The one extra
 * is the flowlet sub-step id (`steps.<call>/<sub>`), which exists only while
 * a flowlet is expanded on the canvas and is stripped on save.
 */
export function walkPath(path, root) {
    if (!path || root == null) return undefined;
    const tokens = anyPathTokens(String(path));
    return tokens ? walkTokens(tokens, root) : undefined;
}

/**
 * Walk a path RELATIVE to an arbitrary value (not the runState roots) — the
 * runtime's own getRelativePath (server/automation/bind.js walkRelativePath),
 * used by the parse_json step editor's live preview so what the user sees is
 * exactly what the runtime extracts. `''`/`'$'`/nullish returns the whole
 * source; `[0].x`, `[*].sku` and `$.a` start at a root list or object.
 */
export function walkRelativePath(path, value) {
    return getRelativePath(value, path);
}

/**
 * Format a sample value for inline display in the variable tree.
 * Strings are shown raw (truncated), numbers/booleans/null serialise
 * naturally, objects/arrays show as `{…}` / `[N items]`.
 */
export function previewValue(value, maxLen = 40) {
    if (value == null) return '—';
    if (typeof value === 'string') {
        return value.length > maxLen ? value.slice(0, maxLen - 1) + '…' : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) return '{}';
        return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''}}`;
    }
    return String(value);
}
