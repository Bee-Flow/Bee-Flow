/**
 * accessAuditPreset: a filter another Compliance page hands to the access log
 * before it navigates there ("show me the changes to the query log"). The hub
 * moves between sections without remounting, and the hosts drop a query string,
 * so a URL parameter cannot carry it. It is read when the access log opens and
 * forgotten when that page is left.
 */
let pending: string[] | null = null;

export function presetAccessAuditActions(actions: readonly string[] | null) {
    pending = actions && actions.length ? [...actions] : null;
}

export function pendingAccessAuditActions(): string | undefined {
    return pending ? pending.join(',') : undefined;
}
