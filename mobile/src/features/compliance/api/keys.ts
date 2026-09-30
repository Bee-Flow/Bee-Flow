/** React-query keys. Every write invalidates `all`: the counts, the lists and the scores move together. */

export const complianceKeys = {
    all: ['compliance'] as const,
    counts: () => ['compliance', 'counts'] as const,
    attention: () => ['compliance', 'attention'] as const,
    deadlines: () => ['compliance', 'deadlines'] as const,
    frameworks: () => ['compliance', 'frameworks'] as const,
    orgUsers: () => ['compliance', 'org-users'] as const,
    checks: (framework: string | null) => ['compliance', 'checks', framework ?? 'all'] as const,
    checkHistory: (checkId: string) => ['compliance', 'check-history', checkId] as const,
    checkEvidence: (checkId: string) => ['compliance', 'check-evidence', checkId] as const,
    settings: () => ['compliance', 'settings'] as const,
    ropa: () => ['compliance', 'ropa'] as const,
    portability: () => ['compliance', 'portability'] as const,
    accessAudit: (action: string | null, offset: number) => ['compliance', 'access-audit', action ?? '', offset] as const,
    accessAuditActions: () => ['compliance', 'access-audit-actions'] as const,
    records: (typeId: string) => ['compliance', 'records', typeId] as const,
    recordDetail: (typeId: string, id: string) => ['compliance', 'record', typeId, id] as const,
    raw: (path: string) => ['compliance', 'raw', path] as const,
    choices: (path: string) => ['compliance', 'choices', path] as const,
};
