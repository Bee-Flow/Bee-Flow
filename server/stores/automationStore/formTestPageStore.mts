/**
 * formTestPageStore.mts: a form's TEST LINK, a page row of its own
 * (automation_form_pages.is_test = TRUE), next to the production page.
 *
 * A test link serves the automation's WORKING copy to its own audience (by
 * default only the person who made it), even while the automation is a draft
 * or switched off, and its submissions start TEST runs: no answers row, no
 * counter, no dashboard entry (formPublic/access.js loadForm,
 * automation/formSubmission.mts). It has its own token, so revoking it never
 * touches the production link, and the production listers skip it
 * (stores/automationStore/forms.js).
 *
 *   createTestFormPage     a fresh test link for one trigger; the one it
 *                          replaces stops working at once
 *   getTestFormPage        the test link that works now, or null
 *   revokeTestFormPages    stop every working test link of a trigger
 *   deleteExpiredTestFormPages  the reaper (scheduler/reapers.js): expired rows
 *                          go once their unclaimed uploads are reaped, so a
 *                          cascade never strands a blob
 *   testLinkExpiresAt      AUTOMATION_FORM_TEST_LINK_DAYS (default 14, 0 = never)
 *
 * Revoking sets expires_at to now rather than deleting: loadForm answers an
 * expired row exactly like an unknown token (404), and the reaper removes it.
 *
 * Plain TypeScript that Node strips on load, importing nothing: the database
 * arrives as `db`, the row mapper and the token as functions (forms.js owns both).
 */

export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null; affectedRows?: number }>;
}

type Env = Record<string, string | undefined>;

export const DEFAULT_TEST_LINK_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When a test link made now stops working; null when AUTOMATION_FORM_TEST_LINK_DAYS is 0. */
export function testLinkExpiresAt(now: number = Date.now(), env: Env = process.env): Date | null {
    const raw = env.AUTOMATION_FORM_TEST_LINK_DAYS;
    let days = DEFAULT_TEST_LINK_DAYS;
    if (raw !== undefined && raw.trim() !== '') {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) days = n;
    }
    return days === 0 ? null : new Date(now + days * DAY_MS);
}

export interface TestPageOptions {
    issuedByUserId: string;
    triggerStepId?: string | null;
    expiresAt?: Date | null;
    audience?: string;
    sharedGroups?: string[];
    sharedUserIds?: string[];
}

const ids = (list: unknown): string => JSON.stringify(Array.isArray(list)
    ? [...new Set(list.filter((v): v is string => typeof v === 'string' && v !== ''))]
    : []);
const changed = (r: { rowCount?: number | null; affectedRows?: number }): number => r.rowCount ?? r.affectedRows ?? 0;

const WORKING = 'is_test = TRUE AND (expires_at IS NULL OR expires_at > NOW())';

export function makeFormTestPageStore<P>(db: Queryable, { ready = async () => {}, toPage, newToken }: {
    ready?: () => Promise<unknown>;
    toPage: (row: Record<string, unknown>) => P;
    newToken: () => string;
}) {
    async function revokeTestFormPages(automationId: string, triggerStepId: string | null = null): Promise<number> {
        await ready();
        return changed(await db.query(
            `UPDATE automation_form_pages SET expires_at = NOW()
              WHERE automation_id = $1 AND trigger_step_id IS NOT DISTINCT FROM $2 AND ${WORKING}`,
            [automationId, triggerStepId],
        ));
    }

    /** A fresh test link. Default audience: the person who made it (and, by the audience rule, the owner). */
    async function createTestFormPage(automationId: string, opts: TestPageOptions): Promise<P> {
        const triggerStepId = opts.triggerStepId ?? null;
        await revokeTestFormPages(automationId, triggerStepId);
        const { rows } = await db.query(
            `INSERT INTO automation_form_pages
                    (id, automation_id, trigger_step_id, audience, shared_groups, shared_user_ids, is_test, issued_by_user_id, expires_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, TRUE, $7, $8)
             RETURNING *`,
            [
                newToken(), automationId, triggerStepId,
                opts.audience === 'org' ? 'org' : 'restricted',
                ids(opts.sharedGroups),
                ids(opts.sharedUserIds ?? [opts.issuedByUserId]),
                opts.issuedByUserId,
                opts.expiresAt ? opts.expiresAt.toISOString() : null,
            ],
        );
        return toPage(rows[0] as Record<string, unknown>);
    }

    async function getTestFormPage(automationId: string, triggerStepId: string | null = null): Promise<P | null> {
        await ready();
        const { rows } = await db.query(
            `SELECT * FROM automation_form_pages
              WHERE automation_id = $1 AND trigger_step_id IS NOT DISTINCT FROM $2 AND ${WORKING}
              ORDER BY created_at DESC LIMIT 1`,
            [automationId, triggerStepId],
        );
        return rows[0] ? toPage(rows[0]) : null;
    }

    async function deleteExpiredTestFormPages(limit = 200): Promise<number> {
        await ready();
        return changed(await db.query(
            `DELETE FROM automation_form_pages
              WHERE id IN (
                    SELECT p.id FROM automation_form_pages p
                     WHERE p.is_test = TRUE AND p.expires_at IS NOT NULL AND p.expires_at < NOW()
                       AND NOT EXISTS (SELECT 1 FROM automation_form_uploads u
                                        WHERE u.form_page_id = p.id AND u.claimed_at IS NULL)
                     ORDER BY p.expires_at
                     LIMIT $1)`,
            [limit],
        ));
    }

    return { createTestFormPage, getTestFormPage, revokeTestFormPages, deleteExpiredTestFormPages };
}
