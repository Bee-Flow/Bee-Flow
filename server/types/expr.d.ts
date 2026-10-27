// Types of the shared expression engine (shared/expr/*.mjs) for the JSDoc type check
// (scripts/typecheck.mjs). Types only: nothing here exists at runtime. They live here
// because shared/expr is mirrored byte for byte into agent-hub and mobile, and every
// line added to a mirrored file is added three times.

declare namespace Expr {
    /**
     * One segment of a parsed value path (shared/expr/path.mjs `parsePath`):
     * a key or an index, `[*]`, or a `[key=literal]` match.
     */
    type PathToken =
        | { type: 'prop'; key: string | number; alt?: string; raw?: string; bare?: boolean }
        | { type: 'wild' }
        | { type: 'match'; key: string; value: string | number | boolean | null };
}
