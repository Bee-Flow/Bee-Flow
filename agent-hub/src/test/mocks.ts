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
