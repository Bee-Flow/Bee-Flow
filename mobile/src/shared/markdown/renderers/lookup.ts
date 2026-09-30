/**
 * A table lookup by a key that came from a model's JSON. `table[key]` would
 * find `constructor`, `toString` and the rest of Object.prototype for a key
 * a model happened to write, and call one as a renderer; only the table's
 * own entries count.
 */
export function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
