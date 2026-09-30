/**
 * The client's half of the server contract: what this build MINIMALLY expects
 * from the server, and how a payload that does not match is degraded into
 * something the screens can render instead of crash on.
 *
 * Why this exists: client.ts casts `res.json()` straight to the caller's type
 * with no runtime check, so a server that renames or drops a field does not
 * produce an error — it produces `undefined` in a component prop, at some
 * later render, on someone else's phone. The pair of defences:
 *
 *   1. serverContract.test.ts pins the server's own serialisation source, so a
 *      rename goes red in CI before an APK exists.
 *   2. The readers below re-shape the payloads the app cannot afford to be
 *      wrong about, through an ALLOW-LIST: unknown fields are ignored, missing
 *      or mistyped fields become a stated default that renders as visible
 *      degradation ("Untitled cowork") rather than a crash or a blank.
 *
 * This module is deliberately dependency-free — no react-native, no expo —
 * because app.config.ts imports MIN_SERVER_BUILD at build time, in plain Node.
 */

/**
 * The oldest server this APK is known to work against, as a build DATE.
 *
 * The server does not expose an orderable version number — /api/health reports
 * a git sha, which cannot be compared — so the check is a capability probe,
 * not an integer comparison: every server built on or after this date serves
 * `GET /api/health/schema` (routes/healthSchema.js, unauthenticated, always
 * 200). A 404 from that path therefore means "older than MIN_SERVER_BUILD".
 * See `checkServerSupport` in server.ts for the probe itself.
 *
 * Raise this date only when the app starts DEPENDING on a newer endpoint or
 * field, and name the dependency here when you do.
 */
export const MIN_SERVER_BUILD = '2026-09-01';

/** Reads one field out of an untrusted payload, total by construction. */
export type FieldReader<T> = (value: unknown) => T;

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The reader vocabulary. Each one answers for ANY input — the whole point is
 * that payload data crossed a network boundary and is not ours to trust.
 *
 * Three families: `x(fallback)` for a required field, `xOrNull` for a
 * nullable one, and `optX` for an optional one (absent stays absent, so the
 * result fits an interface with `?` properties).
 */
export const field = {
    /** A string, or the stated fallback. The fallback is what the user SEES. */
    str(fallback: string): FieldReader<string> {
        return (value) => (typeof value === 'string' ? value : fallback);
    },

    strOrNull(value: unknown): string | null {
        return typeof value === 'string' ? value : null;
    },

    optStr(value: unknown): string | undefined {
        return typeof value === 'string' ? value : undefined;
    },

    bool(fallback: boolean): FieldReader<boolean> {
        return (value) => (typeof value === 'boolean' ? value : fallback);
    },

    optBool(value: unknown): boolean | undefined {
        return typeof value === 'boolean' ? value : undefined;
    },

    /** A finite number, or the fallback. Numeric strings ("3") are accepted —
     *  Postgres COUNT() arrives as a string through some drivers. */
    num(fallback: number): FieldReader<number> {
        return (value) => asCount(value) ?? fallback;
    },

    numOrNull(value: unknown): number | null {
        return asCount(value);
    },

    optNum(value: unknown): number | undefined {
        return asCount(value) ?? undefined;
    },

    /** One of the stated literals, or the fallback. */
    oneOf<T extends string>(allowed: readonly T[], fallback: T): FieldReader<T> {
        return (value) => (allowed.includes(value as T) ? (value as T) : fallback);
    },

    oneOfOrNull<T extends string>(allowed: readonly T[]): FieldReader<T | null> {
        return (value) => (allowed.includes(value as T) ? (value as T) : null);
    },

    optOneOf<T extends string>(allowed: readonly T[]): FieldReader<T | undefined> {
        return (value) => (allowed.includes(value as T) ? (value as T) : undefined);
    },

    /** An array of strings (non-strings dropped), or null. */
    strArrayOrNull(value: unknown): string[] | null {
        if (!Array.isArray(value)) return null;
        return value.filter((v): v is string => typeof v === 'string');
    },

    /** An array of strings (non-strings dropped), or `[]`. */
    strArray(value: unknown): string[] {
        return field.strArrayOrNull(value) ?? [];
    },

    optStrArray(value: unknown): string[] | undefined {
        return field.strArrayOrNull(value) ?? undefined;
    },

    /** An array of shaped rows; anything that is not an array reads as `[]`. */
    list<R>(readRow: (raw: unknown) => R): FieldReader<R[]> {
        return (value) => (Array.isArray(value) ? value.map(readRow) : []);
    },

    listOrNull<R>(readRow: (raw: unknown) => R): FieldReader<R[] | null> {
        return (value) => (Array.isArray(value) ? value.map(readRow) : null);
    },

    optList<R>(readRow: (raw: unknown) => R): FieldReader<R[] | undefined> {
        return (value) => (Array.isArray(value) ? value.map(readRow) : undefined);
    },

    /** An array the app never looks inside, or null. */
    arrayOrNull(value: unknown): unknown[] | null {
        return Array.isArray(value) ? value : null;
    },

    /**
     * An object whose SHAPE is taken on trust — an open-ended config, a flow
     * definition, an app's component tree. The check is only "is it an
     * object"; a screen that reads inside it still has to tolerate gaps.
     */
    record<T extends object>(fallback: T): FieldReader<T> {
        return (value) => (isObject(value) ? (value as T) : fallback);
    },

    recordOrNull<T extends object = Record<string, unknown>>(value: unknown): T | null {
        return isObject(value) ? (value as T) : null;
    },

    optRecord<T extends object = Record<string, unknown>>(value: unknown): T | undefined {
        return isObject(value) ? (value as T) : undefined;
    },

    /** Passed through untouched: payloads the app carries but never reads. */
    raw(value: unknown): unknown {
        return value;
    },
} as const;

/** A finite number out of a number or numeric string, else null. */
export function asCount(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

/** One property of an untrusted payload, or undefined when there is no object. */
export function pick(raw: unknown, key: string): unknown {
    return isObject(raw) ? raw[key] : undefined;
}

/**
 * Build a reader for a whole payload from a spec of per-field readers.
 *
 * The spec IS the allow-list: the result carries exactly the spec'd keys —
 * a field the server adds next year flows past untouched, a field it drops
 * becomes that reader's default, and a payload that is not an object at all
 * (null, a string, an HTML error page that parsed as JSON) yields the
 * all-defaults object rather than a throw.
 */
export function shapeOf<S extends Record<string, FieldReader<unknown>>>(
    spec: S,
): (raw: unknown) => { [K in keyof S]: ReturnType<S[K]> } {
    const keys = Object.keys(spec) as (keyof S & string)[];
    return (raw: unknown) => {
        const source =
            raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        const out = {} as { [K in keyof S]: ReturnType<S[K]> };
        for (const key of keys) {
            out[key] = spec[key]!(source[key]) as ReturnType<S[typeof key]>;
        }
        return out;
    };
}

/**
 * A list payload: the array itself, `[]` for anything that is not one, and
 * rows that are not objects dropped before the row reader ever sees them.
 * (A row that IS an object but lacks its id still comes through — with the
 * id defaulted — so the caller decides whether an id-less row is renderable.)
 */
export function shapeListOf<S extends Record<string, FieldReader<unknown>>>(
    spec: S,
): (raw: unknown) => { [K in keyof S]: ReturnType<S[K]> }[] {
    const readRow = shapeOf(spec);
    return (raw: unknown) => {
        if (!Array.isArray(raw)) return [];
        return raw
            .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
            .map(readRow);
    };
}

/**
 * An entity or nothing: the reader applied to an object, `null` for anything
 * else. This keeps the `T | null` the callers already handle — a 204, an
 * empty body — without turning "nothing came back" into an all-defaults row.
 */
export function nullable<T>(read: (raw: unknown) => T): (raw: unknown) => T | null {
    return (raw) => (isObject(raw) ? read(raw) : null);
}
