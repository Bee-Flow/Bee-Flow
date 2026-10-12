// One guard shared by the shell and embedded workspaces. Never owns form data.
// The guard may ask in a dialog, so it can answer later: callers await it.
type Guard = () => boolean | Promise<boolean>;
let guard: Guard | null = null;
export function registerNavigationGuard(next: Guard) {
    guard = next;
    return () => { if (guard === next) guard = null; };
}
export function mayNavigate(): boolean | Promise<boolean> { return !guard || guard(); }

/**
 * Run `go` when the guard allows it. Synchronous when the guard answers at
 * once (or there is none), so ordinary navigation keeps its timing; when the
 * guard asks in a dialog, `go` runs after the answer, and never on "stay".
 */
export function whenMayNavigate(go: () => void): void {
    const allowed = mayNavigate();
    if (allowed === true) go();
    else if (allowed !== false) void allowed.then((ok) => { if (ok) go(); });
}
