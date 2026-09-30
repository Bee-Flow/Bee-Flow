/**
 * The path tokenizer/resolver, ported from agent-hub `utils/bindingHelpers.js`
 * (§WS4.1), which in turn mirrors the SERVER runtime
 * (server/automation/bind.js tokenizePath/resolveTokens) in semantics. Keeping
 * the three in lock-step is what makes a preview on the phone match what the
 * automation actually sees — `[*]` flatten, quoted keys, and no walking of the
 * prototype chain. Pinned by bindingHelpers.lockstep.test.ts.
 */

type Token = { type: 'prop'; key: string | number } | { type: 'wild' };

/** One `[...]` segment, from the character after `[` up to `]`. */
function bracketToken(raw: string): Token {
    if (raw === '*') return { type: 'wild' };
    if (raw.startsWith('"') && raw.endsWith('"')) return { type: 'prop', key: raw.slice(1, -1) };
    if (raw.startsWith("'") && raw.endsWith("'")) return { type: 'prop', key: raw.slice(1, -1) };
    return { type: 'prop', key: parseInt(raw, 10) };
}

function tokenizePath(path: string): Token[] | null {
    const tokens: Token[] = [];
    let i = 0;
    let buf = '';
    const flush = () => {
        if (buf.length) {
            tokens.push({ type: 'prop', key: buf });
            buf = '';
        }
    };
    while (i < path.length) {
        const c = path.charAt(i);
        if (c === '.') {
            flush();
            i++;
            continue;
        }
        if (c === '[') {
            flush();
            const close = path.indexOf(']', i);
            if (close < 0) return null;
            tokens.push(bracketToken(path.slice(i + 1, close)));
            i = close + 1;
            continue;
        }
        buf += c;
        i++;
    }
    flush();
    return tokens;
}

function resolveWild(rest: Token[], cur: unknown): unknown {
    if (!Array.isArray(cur)) return undefined;
    const out: unknown[] = [];
    for (const el of cur) {
        const m = resolveTokens(rest, el);
        if (m === undefined) continue;
        if (Array.isArray(m)) out.push(...m);
        else out.push(m);
    }
    return out;
}

function resolveTokens(tokens: Token[], start: unknown): unknown {
    let cur = start;
    for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t] as Token;
        if (tok.type === 'wild') return resolveWild(tokens.slice(t + 1), cur);
        if (cur == null) return undefined;
        // Never walk the prototype chain — mirrors server bind.js: a path like
        // "constructor" previews as undefined, exactly as it resolves at run time.
        if (!Object.prototype.hasOwnProperty.call(cur, tok.key)) return undefined;
        cur = (cur as Record<string | number, unknown>)[tok.key];
    }
    return cur;
}

/**
 * Walk a dotted/bracketed path on an object (`steps.s1.output.results[0].subject`,
 * `…results[*].output.field`, `obj["quoted key"]`). Undefined when any segment
 * is missing — never throws.
 */
export function walkPath(path: unknown, root: unknown): unknown {
    if (!path || root == null) return undefined;
    const tokens = tokenizePath(String(path));
    if (!tokens) return undefined;
    return resolveTokens(tokens, root);
}

// Mirrors server bind.js REF_RE — walkRelativePath enforces it so a relative
// path resolves IDENTICALLY at design time and at run time.
const REF_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[(?:[0-9]+|\*|"[^"]*"|'[^']*')\])*$/;

/**
 * Walk a path RELATIVE to an arbitrary value — byte-for-byte mirror of
 * server/automation/bind.js walkRelativePath. `''`/`'$'`/nullish returns the
 * whole value.
 */
export function walkRelativePath(path: unknown, value: unknown): unknown {
    if (path === '' || path === '$' || path == null) return value;
    const p = String(path);
    const abs = p.startsWith('[') ? `$${p}` : `$.${p}`;
    if (!REF_RE.test(abs)) return undefined;
    const tokens = tokenizePath(abs);
    if (!tokens) return undefined;
    return resolveTokens(tokens, { $: value });
}

/**
 * A sample value for inline display: strings raw (truncated), numbers and
 * booleans as text, objects/arrays as `{a, b…}` / `[N items]`.
 */
export function previewValue(value: unknown, maxLen = 40): string {
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
