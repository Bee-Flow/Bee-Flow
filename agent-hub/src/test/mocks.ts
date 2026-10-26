// Shared typing helpers for mocks.
import type { Mock } from 'vitest';

/**
 * The mock behind an import that the test replaced with `vi.mock(...)`.
 *
 * Typed as vitest's default `Mock`, which is what a bare `vi.fn()` is: the
 * fixtures a test feeds such a mock (a partial `Response`, a trimmed record)
 * are partial by design, so the mock accepts what the real signature would
 * refuse. The one cast sits here instead of at every call site.
 *
 *   asMock(authFetch).mockResolvedValue(ok({ items: [] }));
 */
export function asMock(fn: unknown): Mock {
    return fn as Mock;
}

/** Recursively optional, for fixtures that spell out only what the test reads. */
export type DeepPartial<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer U)[]
        ? readonly DeepPartial<U>[]
        : T extends object
            ? { [K in keyof T]?: DeepPartial<T[K]> }
            : T;

/**
 * A fixture that carries only the fields the test reads, typed as the full `T`.
 * The literal is still checked against `T` (a misspelt or unknown key is an
 * error); only the required fields may be left out. The cast lives here.
 *
 *   render(<Panel app={partial<AppRow>({ id: 'a1', name: 'Demo' })} />);
 */
export function partial<T>(value: DeepPartial<T>): T {
    return value as T;
}

/**
 * A fixture typed as the full `T` without checking it: for data whose inferred
 * literal types are wider than `T`'s (`string` where a union is declared) or
 * that is trimmed in ways `partial` cannot express. Prefer `partial`, or a
 * typed builder next to the test, when the fixture is reused.
 */
export function stub<T>(value: unknown): T {
    return value as T;
}

/**
 * A deliberately invalid input (null where a string is required, a string where
 * a list is required), to show the code under test copes with what the types
 * forbid. Say it with this call instead of a cast so the intent is greppable.
 *
 *   expect(buildPeekIndex(malformed<PeekRow[]>('nope'), opts).size).toBe(0);
 */
export function malformed<T>(value: unknown): T {
    return value as T;
}
