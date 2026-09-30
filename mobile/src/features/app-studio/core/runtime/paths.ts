/**
 * Path walking and stable hashing for bindings. Part of the port of agent-hub
 * AppStudio/runtime/resolveBinding.js (resolveBinding.lockstep.test.ts).
 */

/** 'rows[0].title' -> ['rows','0','title']; tolerant of quotes and malformed tails. */
function parsePathSegments(path: string): string[] {
    const out: string[] = [];
    let buf = '';
    const flush = () => {
        if (buf !== '') {
            out.push(buf);
            buf = '';
        }
    };
    for (let i = 0; i < path.length; i++) {
        const c = path[i] as string;
        if (c === '.') {
            flush();
            continue;
        }
        if (c !== '[') {
            buf += c;
            continue;
        }
        flush();
        const close = path.indexOf(']', i);
        if (close < 0) {
            buf += path.slice(i); // malformed: keep the rest literal
            break;
        }
        const raw = unquote(path.slice(i + 1, close).trim());
        if (raw !== '') out.push(raw);
        i = close;
    }
    flush();
    return out;
}

function unquote(raw: string): string {
    const quoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
    return quoted ? raw.slice(1, -1) : raw;
}

/**
 * Safe path walk with dot AND bracket notation: 'rows.0.title',
 * 'rows[0].title', 'data["a-b"]'. Missing segments are undefined; never throws.
 */
export function walkPath(value: unknown, path: unknown): unknown {
    if (path == null || path === '') return value;
    if (typeof path !== 'string') return undefined;
    let current = value;
    for (const segment of parsePathSegments(path)) {
        if (current == null || typeof current !== 'object') return undefined;
        current = Object.prototype.hasOwnProperty.call(current, segment)
            ? (current as Record<string, unknown>)[segment]
            : undefined;
    }
    return current;
}

/** Deterministic JSON with sorted keys: the hash half of a data cache key. */
export function stableStringify(value: unknown): string {
    if (value == null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value) as string;
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
