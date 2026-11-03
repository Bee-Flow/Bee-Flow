/**
 * approvalSandbox.mts: the sandbox-seat columns of automation_approvals
 * (automation-run-profile-2026-11) and the two reaper sweeps that must skip them.
 *
 *   is_test             a test or dry run's approval: the person who started
 *                       the run decides alone (core/automationRunner/approvalRouting.mts)
 *   sandbox_user_id     that person
 *   configured_routing  where the step WOULD have gone in production (stages /
 *                       panel / assignee, ids only), for the "in production
 *                       this goes to ..." preview; never used to route
 *
 * markDueApprovalReminders / markDueApprovalEscalations: the reaper's
 * conditional UPDATEs (the stamp is claimed exactly once across pods). Never
 * on a test approval: the sandbox seat is written without clocks, and the
 * sweeps refuse one all the same.
 *
 * Plain TypeScript that Node strips on load, importing nothing: the database
 * arrives as `db` (pauseRowStore.mts does the same), and the pg test runs it on
 * PGlite.
 */

export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type SandboxColumns = {
    isTest?: boolean | null;
    sandboxUserId?: string | null;
    configuredRouting?: unknown;
};

/** The mapped fields of a raw row. */
export function sandboxFields(r: Record<string, unknown>): { isTest: boolean; sandboxUserId: string | null; configuredRouting: unknown } {
    let routing: unknown = r.configured_routing ?? null;
    if (typeof routing === 'string') {
        try { routing = JSON.parse(routing); } catch { routing = null; }
    }
    return {
        isTest: r.is_test === true,
        sandboxUserId: typeof r.sandbox_user_id === 'string' ? r.sandbox_user_id : null,
        configuredRouting: routing,
    };
}

/** The INSERT parameters of the three columns; NULL on every production row. */
export function sandboxParams({ isTest = false, sandboxUserId = null, configuredRouting = null }: SandboxColumns = {}): [true | null, string | null, string | null] {
    if (!isTest) return [null, null, null];
    return [true, sandboxUserId || null, configuredRouting ? JSON.stringify(configuredRouting) : null];
}

export function makeApprovalSweeps<T>(db: Queryable, toApproval: (r: Record<string, unknown>) => T) {
    /**
     * Stamp due reminders. Conditional on reminder_sent_at IS NULL, so of N
     * pods sweeping concurrently exactly one gets each row back: the reminder
     * bell rings once. Fires only while pending: a decided row needs no nudge.
     */
    async function markDueApprovalReminders(): Promise<T[]> {
        const { rows } = await db.query(
            `UPDATE automation_approvals
                SET reminder_sent_at = NOW(), updated_at = NOW()
              WHERE status = 'pending' AND remind_at IS NOT NULL
                AND remind_at <= NOW() AND reminder_sent_at IS NULL
                AND is_test IS NOT TRUE
              RETURNING *`,
            [],
        );
        return rows.map(toApproval);
    }

    /**
     * Stamp due escalations. The stamp IS the grant: canDecide and the viewer
     * WHERE both admit escalate_to_* only once escalated_at is set.
     */
    async function markDueApprovalEscalations(): Promise<T[]> {
        const { rows } = await db.query(
            `UPDATE automation_approvals
                SET escalated_at = NOW(), updated_at = NOW()
              WHERE status = 'pending' AND escalate_at IS NOT NULL
                AND escalate_at <= NOW() AND escalated_at IS NULL
                AND (escalate_to_user_id IS NOT NULL OR escalate_to_group_id IS NOT NULL)
                AND is_test IS NOT TRUE
              RETURNING *`,
            [],
        );
        return rows.map(toApproval);
    }

    return { markDueApprovalReminders, markDueApprovalEscalations };
}
