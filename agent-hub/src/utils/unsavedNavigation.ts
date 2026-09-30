// One guard shared by the shell and embedded workspaces. Never owns form data.
let guard: (() => boolean) | null = null;
export function registerNavigationGuard(next: () => boolean) {
    guard = next;
    return () => { if (guard === next) guard = null; };
}
export function mayNavigate(): boolean { return !guard || guard(); }
