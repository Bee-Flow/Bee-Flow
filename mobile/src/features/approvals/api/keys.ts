/** React Query keys for approvals, under the Automate tab's 'automate' prefix. */

export const approvalKeys = {
    approval: (id: string) => ['automate', 'approval', id] as const,
    approvals: (status: string) => ['automate', 'approvals', status] as const,
};
