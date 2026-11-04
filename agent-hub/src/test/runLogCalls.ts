/**
 * The authFetch calls of an action run WITHOUT the run log's end report (POST …/runs/end, sent
 * once when a server-touching sequence settles; runtime/actionRunner/runEnd.ts). For tests that
 * count or index the step POSTs.
 */
type Calls = { mock: { calls: unknown[][] } };

export function stepPosts(fn: unknown): unknown[][] {
    return (fn as Calls).mock.calls.filter((c) => !String(c[0]).includes('/runs/end'));
}

export function runEndPosts(fn: unknown): unknown[][] {
    return (fn as Calls).mock.calls.filter((c) => String(c[0]).includes('/runs/end'));
}
