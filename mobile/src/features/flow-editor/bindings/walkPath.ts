/**
 * Reading paths, ported from agent-hub `utils/bindingHelpers.js`, over the
 * ONE path grammar the runtime resolves (shared/expr path.mjs, vendored
 * byte for byte in `@/shared/expr`). server/automation/bind.js walks every
 * ref and `{{ }}` placeholder with the same functions, so a preview on the
 * phone is exactly what the run will see: `["Story Points"]`, `[name="Subject"]`,
 * `[-1]`, JSON text read as the value it encodes, and the same `[*]` rules.
 * This file used to carry its own laxer tokenizer, which previewed spellings
 * (`fields.Story Points`, `value[0x1]`) the run never resolved. Pinned by
 * bindingHelpers.lockstep.test.ts.
 */

import { getRelativePath, walkTokens, type PathToken } from '@/shared/expr';

import { pathTokensOf as anyPathTokens } from '../model/pathGrammar';

// Which text is a path, its canonical spelling and what it is named after
// live one layer down, where the condition model (model/route/) and the
// display helpers (model/displayHelpers) use them too.
export {
    canonicalRefPath, detectTemplate, isCleanPath, leafOf, pathLabelParts, pathLeafKey, refPathTokens,
} from '../model/pathGrammar';

/** The tokens of any path the builder holds (exported for the name helpers). */
export function pathTokensOf(text: unknown): PathToken[] | null {
    return anyPathTokens(text);
}

/**
 * Walk a dotted/bracketed path on an object — the runtime's own walker.
 * Undefined when any segment is missing; never throws.
 */
export function walkPath(path: unknown, root: unknown): unknown {
    if (!path || root == null) return undefined;
    const tokens = anyPathTokens(String(path));
    return tokens ? walkTokens(tokens, root) : undefined;
}

/**
 * Walk a path RELATIVE to an arbitrary value — the runtime's getRelativePath
 * (server/automation/bind.js walkRelativePath). `''`/`'$'`/nullish returns
 * the whole value.
 */
export function walkRelativePath(path: unknown, value: unknown): unknown {
    return getRelativePath(value, path);
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
