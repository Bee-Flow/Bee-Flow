// Result shapes of the automation builder tools (automation/builderTools/**) for the JSDoc
// type check (scripts/typecheck.mjs). Types only: nothing here exists at runtime.
//
// A builder helper answers with its value or with `{ error, _fixHint }`, which the model
// reads to correct itself. Every key of the success shape is listed as `undefined` on the
// failure and `error` as `undefined` on the success, so `if (r.error) return r;` narrows
// at every strictness level (without strictNullChecks a plain union does not narrow).

declare namespace Builder {
    /** The arguments a model passed to a builder tool: untrusted JSON, read key by key. */
    type Args = Record<string, unknown>;
    /** One table of the "Datatables you may use" block the builder is shown. */
    interface CatalogTable {
        id: string;
        key: string;
        name: string;
        canWrite?: boolean;
        managedKind?: string | null;
        pending?: boolean;
        columns?: Array<{ key: string; name?: string; type?: string; unique?: boolean }>;
    }
    /** The failure answer. `rejectedPath` etc. ride along when a tool names the offending input. */
    interface Failure {
        error: string;
        _fixHint: string;
        _rejectedPath?: string;
        _askArgs?: unknown;
    }
    /** Success `T`, readable as `r.error === undefined`. */
    type Ok<T> = T & { error?: undefined; _fixHint?: undefined };
    /** Failure that leaves every key of `T` undefined. */
    type Fail<T> = Failure & { [K in keyof T]?: undefined };
    /** `T` or the failure, narrowable on `r.error`. */
    type Result<T> = Ok<T> | Fail<T>;
}
