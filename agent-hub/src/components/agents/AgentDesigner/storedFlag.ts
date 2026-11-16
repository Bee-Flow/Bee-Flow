/**
 * An on/off column of an agent row (`is_published`, `embed_enabled`,
 * `workspace_enabled`, `copy_enabled`), read the way the row actually stores it.
 *
 * On Postgres these are BOOLEAN columns and come back as true/false; the
 * SQLite-era readers asked `x === 1` (a published agent read as unpublished)
 * or `x !== 0` (`false !== 0` is true: an OFF setting read as ON). The integer
 * and text spellings are still recognised; anything else reads as `fallback`.
 * Mirrors server/usecases/agents/storedFlag.js.
 */
export function storedFlag(value: unknown, fallback: boolean): boolean {
    if (value === true || value === 1 || value === 't' || value === 'true') return true;
    if (value === false || value === 0 || value === 'f' || value === 'false') return false;
    return fallback;
}

/** The agent's `config` as an object: a row from an older store hands it back as JSON text. */
export function storedConfig(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        } catch {
            return {};
        }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
