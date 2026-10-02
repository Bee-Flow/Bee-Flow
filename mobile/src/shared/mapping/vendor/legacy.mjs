/**
 * The legacy binding grammar and walker: a verbatim port of what
 * server/automation/bind.js has always done. Frozen.
 *
 * Every stored automation holds refs and `{{ }}` templates in this dialect,
 * so nothing here may change what an existing path resolves to. corpus.mjs
 * was recorded from bind.js before the code moved here and pins every case;
 * when a result has to change, a milestone changes it on purpose and updates
 * the corpus in the same commit.
 *
 * Isomorphic and dependency-free: the server runtime loads it through
 * bind.js, agent-hub and mobile load their generated copies for previews, so
 * a preview resolves a path exactly as the run will. The one server-only
 * concern (a debug log on an unresolved template path) comes in as a
 * callback; see interpolateTemplate.
 */

export const REF_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[(?:[0-9]+|\*|"[^"]*"|'[^']*')\])*$/;

// Defensive deep-clone for binding values. Without this, an object literal
// in a definition (`{kind:'literal', value:{...}}`) would be returned by
// reference — a downstream step mutating its inputs would silently corrupt
// the definition's binding for every subsequent run. Primitives are
// returned as-is to keep the hot path cheap.
export function cloneLiteral(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return structuredClone(value); }
    catch { return JSON.parse(JSON.stringify(value)); }
}

/**
 * Tokenize a dotted/bracketed path into prop / index / wildcard tokens.
 * Returns null on a malformed path (unclosed bracket).
 */
export function tokenizePath(path) {
    const tokens = [];
    let i = 0;
    let buf = '';
    const flush = () => { if (buf.length) { tokens.push({ type: 'prop', key: buf }); buf = ''; } };
    while (i < path.length) {
        const c = path[i];
        if (c === '.') { flush(); i++; continue; }
        if (c === '[') {
            flush();
            const close = path.indexOf(']', i);
            if (close < 0) return null;
            const raw = path.slice(i + 1, close);
            if (raw === '*') tokens.push({ type: 'wild' });
            else if (raw.startsWith('"') && raw.endsWith('"')) tokens.push({ type: 'prop', key: raw.slice(1, -1) });
            else if (raw.startsWith("'") && raw.endsWith("'")) tokens.push({ type: 'prop', key: raw.slice(1, -1) });
            else tokens.push({ type: 'prop', key: parseInt(raw, 10) });
            i = close + 1;
            continue;
        }
        buf += c;
        i++;
    }
    flush();
    return tokens;
}

/**
 * Resolve a token list against a value. A `[*]` wildcard maps the rest of
 * the path over each element of the current array and flattens the result
 * one level — so `steps.read.output.results[*].output.attachments` (each
 * element yielding an array) collapses into a single flat array of
 * attachments, which is exactly what a downstream "for each" needs.
 */
export function resolveTokens(tokens, cur) {
    for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (tok.type === 'wild') {
            if (!Array.isArray(cur)) return undefined;
            const rest = tokens.slice(t + 1);
            const out = [];
            for (const el of cur) {
                const m = resolveTokens(rest, el);
                if (m === undefined) continue;
                if (Array.isArray(m)) out.push(...m);
                else out.push(m);
            }
            return out;
        }
        if (cur == null) return undefined;
        // Never walk the prototype chain — a path like
        // "steps.s1.output.constructor.name" or a bracket-indexed
        // equivalent must resolve to undefined, not leak internal
        // object/function references into a rendered template. This still
        // allows every legitimate access: array/string indices and
        // `.length` are own properties (verified: `hasOwnProperty.call`
        // auto-boxes primitives), only prototype-chain members like
        // `.constructor`/`.__proto__`/`.toFixed` are excluded.
        if (!Object.prototype.hasOwnProperty.call(cur, tok.key)) return undefined;
        cur = cur[tok.key];
    }
    return cur;
}

/**
 * Walk a dotted/bracketed path on an object. Used by both ref-resolution
 * and the inside of {{...}} templates. Tolerates undefined intermediates,
 * and supports `[*]` wildcards for flattening across arrays.
 *
 * STRICT: a path REF_RE rejects (`items.0.x`, `body.content-type`) is
 * undefined, never "what a laxer reading would find". The web and mobile
 * previews use this same function, so they show what the run will get.
 */
export function walkPath(path, root) {
    if (!path || typeof path !== 'string') return undefined;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- REF_RE is anchored at both ends and each repeated segment starts with a character (. or [) the run before it cannot match, so matching is linear
    if (!REF_RE.test(path)) return undefined;
    const tokens = tokenizePath(path);
    if (!tokens) return undefined;
    return resolveTokens(tokens, root);
}

/**
 * Walk a path RELATIVE to an arbitrary value (not the runState roots).
 * Used by the parse_json step and the design-time map-json-fields endpoint.
 *
 * Wrapping the value as `{$: value}` and prefixing the path with `$`/`$.`
 * keeps REF_RE satisfied (it rejects a leading `[`) while allowing
 * root-array sources (`[0].x`, `[*].sku`), and reuses resolveTokens'
 * `[*]` flatten + prototype-chain block unchanged. `''`/`'$'`/nullish
 * returns the whole source.
 */
export function walkRelativePath(path, value) {
    if (path === '' || path === '$' || path == null) return value;
    const p = String(path);
    return walkPath(p.startsWith('[') ? `$${p}` : `$.${p}`, { $: value });
}

/**
 * Interpolate a template string with {{ path }} segments. `undefined` and
 * `null` paths render as the empty string (callers historically depend on
 * this — e.g. notification bodies and prompt prefixes). To make the silent
 * failure mode discoverable, when a path resolves to `undefined` we record
 * it on `runState._templateWarnings` (if the array exists) so the runner
 * can surface a per-run warning summary, and call `onUnresolved(path)` when
 * given (bind.js logs there under `AUTOMATION_DEBUG_BINDINGS=1`).
 *
 * @param {*} template
 * @param {object} runState
 * @param {object} [opts]
 * @param {boolean} [opts.leaveUnresolved] — when true, a `{{token}}` whose
 *   path resolves to `undefined` is returned VERBATIM (braces and all)
 *   rather than blanked. Used for AI-step prompts so a literal `{{...}}`
 *   the builder typed (and any not-yet-available reference) isn't silently
 *   deleted from the instruction text. Default false keeps the historical
 *   blank-on-miss behaviour for notification/stop_error callers.
 * @param {boolean} [opts.listAsMarkdown] — when true, a path that resolves to
 *   an array of plain values renders as a markdown bullet list instead of as
 *   JSON. Used ONLY for the human-readable text of a form page, which IS
 *   rendered as markdown: a step that produced a list of findings put
 *   `["Productaanbod van RVS platen…","Algemene bedrijfspresentatie…"]`,
 *   brackets and quotes and all, on a page a customer reads. Everywhere else —
 *   prompts, URLs, headers, notification bodies — JSON stays correct, so this
 *   is opt-in rather than a change to the default.
 * @param {(path: string) => void} [onUnresolved]
 */
export function interpolateTemplate(template, runState, opts = {}, onUnresolved) {
    const { leaveUnresolved = false, listAsMarkdown = false } = opts;
    // A list of plain values is the only shape worth reformatting: an array of
    // objects has no sensible one-line form, so it keeps its JSON.
    const asMarkdownList = (v) => {
        if (!listAsMarkdown || !Array.isArray(v)) return null;
        if (!v.length) return '';
        if (!v.every(x => x == null || ['string', 'number', 'boolean'].includes(typeof x))) return null;
        // Blank line first: a bullet list has to start its own block, or it
        // glues itself onto the label that introduces it.
        const NL = String.fromCharCode(10);
        return NL + NL + v.map(x => '- ' + (x == null ? '' : String(x).trim())).join(NL) + NL;
    };
    return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, path) => {
        const trimmed = path.trim();
        const v = walkPath(trimmed, runState);
        if (v === undefined) {
            if (runState && Array.isArray(runState._templateWarnings)) {
                runState._templateWarnings.push(trimmed);
            }
            if (onUnresolved) onUnresolved(trimmed);
            return leaveUnresolved ? whole : '';
        }
        if (v === null) return '';
        const list = asMarkdownList(v);
        if (list !== null) return list;
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
}
