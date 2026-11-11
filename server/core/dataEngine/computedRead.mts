/**
 * Run a record read that may carry read-time computed fields
 * (compileRecordList / compileGetById with `readTimeComputed: true`).
 *
 * A computed expression the guard accepted can still fail on the engine:
 * Postgres raises on a division by zero, a cast that does not parse, or a
 * function given the wrong type (`upper(<number>)`), and an error there fails
 * the whole statement. One field must not cost the viewer the whole read, so
 * on a failure the same read runs again with every computed field NULL (the
 * compiled `fallbackSql`, same params) and the answer says which fields read
 * empty. When that read fails too, the first error is thrown, so a read that
 * fails for any other reason fails exactly as it did before.
 *
 * Each engine call is its own statement (studioAppDbStore `query`: one
 * transaction per call on Postgres), so the failed attempt leaves nothing open.
 *
 * The note names the field, never the engine's message: that text can quote a
 * row's value, and notes reach public pages too.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log') as { warn(msg: string, meta?: Record<string, unknown>): void };

type ComputedMeta = { keys: string[]; refused: string[]; fallbackSql: string };
type CompiledRead = { sql: string; params: unknown[]; readTimeComputed?: ComputedMeta };

/** The note for a computed field that reads empty. */
export function computedNote(key: string): string {
    return `Computed field "${key}" could not be evaluated and reads empty.`;
}

/**
 * `query(compiled.sql, compiled.params)`, with the computed fallback. `notes`
 * is empty when every computed field was evaluated (or the read has none).
 */
export async function queryWithComputed<R>(
    query: (sql: string, params: unknown[]) => Promise<R> | R,
    compiled: CompiledRead,
): Promise<{ result: R; notes: string[] }> {
    const meta = compiled.readTimeComputed;
    if (!meta) return { result: await query(compiled.sql, compiled.params), notes: [] };
    try {
        const result = await query(compiled.sql, compiled.params);
        return { result, notes: meta.refused.map(computedNote) };
    } catch (err) {
        let result: R;
        try {
            result = await query(meta.fallbackSql, compiled.params);
        } catch {
            throw err;
        }
        const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : null;
        log.warn('[dataEngine/computedRead] a read-time computed expression failed; the fields read empty', { fields: meta.keys, code });
        return { result, notes: meta.keys.map(computedNote) };
    }
}
