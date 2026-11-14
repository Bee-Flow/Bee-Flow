/**
 * App Studio builder: keep a tool result under the builder's tool-result limit.
 *
 * The chat route sends a tool result to the model through truncateJson
 * (usecases/ai/appStudioBuilder/turnLoop.js, 30,000 characters). A result over it becomes a cut-off
 * preview the model cannot read as JSON, so a tool whose answer can grow (a run report with 300
 * steps, a test run, a run log page) shortens it itself first: the longest list is halved until
 * the answer fits, and `_trimmed` says what was left out. Pure.
 */

type Obj = Record<string, unknown>;

/** truncateJson's default (usecases/ai/appStudioBuilder/turnLoop.js). */
export const BUILDER_TOOL_RESULT_CHARS = 30_000;
/** Room for the `_trimmed` notes and the hints the dispatcher adds after the tool. */
const MARGIN = 1_500;
const MAX_ROUNDS = 60;
const MAX_DEPTH = 5;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const size = (v: unknown): number => JSON.stringify(v ?? null).length;

type Found = { list: unknown[]; path: string; chars: number };

/** Every list inside `value` (depth-bounded) with its JSON size. */
function lists(value: unknown, path: string, depth: number, out: Found[]): Found[] {
    if (depth > MAX_DEPTH) return out;
    if (Array.isArray(value)) {
        if (value.length > 1) out.push({ list: value, path: path || '(root)', chars: size(value) });
        value.forEach((v, i) => lists(v, `${path}[${i}]`, depth + 1, out));
    } else if (isObject(value)) {
        for (const [k, v] of Object.entries(value)) lists(v, path ? `${path}.${k}` : k, depth + 1, out);
    }
    return out;
}

/** The largest top-level value that is not the answer's frame. */
function largestField(result: Obj): string | null {
    let best: string | null = null;
    let bestChars = 0;
    for (const [k, v] of Object.entries(result)) {
        if (k === 'error' || k === '_fixHint' || k === '_trimmed' || typeof v !== 'object' || v === null) continue;
        const chars = size(v);
        if (chars > bestChars) { best = k; bestChars = chars; }
    }
    return best;
}

/**
 * `result` as it goes to the model, within `max` characters of JSON. Unchanged (the same
 * object) when it already fits; otherwise a copy with lists halved from the end and, as a last
 * resort, a large field replaced by a sentence.
 */
export function fitToolResult<T extends Obj>(result: T, max: number = BUILDER_TOOL_RESULT_CHARS - MARGIN): T | Obj {
    if (!isObject(result) || size(result) <= max) return result;
    const out = JSON.parse(JSON.stringify(result)) as Obj;
    const cut = new Map<string, { kept: number; total: number }>();
    for (let round = 0; round < MAX_ROUNDS && size(out) > max; round += 1) {
        const biggest = lists(out, '', 0, []).sort((a, b) => b.chars - a.chars)[0];
        if (biggest) {
            const total = cut.get(biggest.path)?.total ?? biggest.list.length;
            biggest.list.length = Math.ceil(biggest.list.length / 2);
            cut.set(biggest.path, { kept: biggest.list.length, total });
            continue;
        }
        const field = largestField(out);
        if (!field) break;
        out[field] = '(left out: too large for one answer)';
        cut.set(field, { kept: 0, total: 0 });
    }
    out._trimmed = [...cut].map(([path, c]) => (c.total ? `${path}: the first ${c.kept} of ${c.total}` : `${path}: left out`));
    return out;
}
