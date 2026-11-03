/**
 * formJourneyStore.mts: the rows automation/formJourney.mts touches when a form
 * journey pauses (WI-12, D4c):
 *
 *   formSessionsOfJourney   the visitor sessions of a run's journey (a session's
 *                           run_id may point at ANY leg: the approval resume does
 *                           not re-point it), with the page token they belong to
 *   extendFormSessionUntil  keep a session alive up to `until`; never shortens
 *                           one and never revives one that already expired
 *   claimFormPageNotice     the "next page is ready" notice of one paused leg,
 *                           claimed once: a ledger row in
 *                           automation_notification_events (event onFormPageDue,
 *                           channel bell). A second claim for the same leg finds
 *                           the row and answers null, so a finalize that runs
 *                           twice never sends twice. A leg pauses on exactly one
 *                           step, so the leg's id names the (run, step) pair.
 *   settleFormPageNotice    what the claim delivered: the bell row's
 *                           delivered_at, and an e-mail row when one was tried
 *
 * Plain TypeScript that Node strips on load, importing nothing: the database
 * arrives as `db` (pauseRowStore.mts does the same), and the pg test runs it on
 * PGlite.
 */

export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null; affectedRows?: number }>;
}

export const FORM_PAGE_DUE_EVENT = 'onFormPageDue';

export interface JourneySession {
    id: string;
    formPageId: string;
    isTest: boolean;
    expiresAt: string | null;
}

const JOURNEY_RUN_IDS = `SELECT l.id FROM automation_runs l
          WHERE COALESCE(l.root_run_id, l.id) = (SELECT COALESCE(root_run_id, id) FROM automation_runs WHERE id = $1)`;

const changed = (r: { rowCount?: number | null; affectedRows?: number }): number => r.rowCount ?? r.affectedRows ?? 0;

const iso = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function makeFormJourneyStore(db: Queryable, { ready = async () => {}, newId = defaultId }: {
    ready?: () => Promise<unknown>;
    newId?: () => string;
} = {}) {
    async function formSessionsOfJourney(runId: string): Promise<JourneySession[]> {
        if (!runId) return [];
        await ready();
        const { rows } = await db.query(
            `SELECT id, form_page_id, COALESCE(is_test, FALSE) AS is_test, expires_at FROM automation_form_sessions
              WHERE run_id IN (${JOURNEY_RUN_IDS})`,
            [runId],
        );
        return rows.map((r) => ({
            id: String(r.id),
            formPageId: String(r.form_page_id),
            isTest: r.is_test === true,
            expiresAt: iso(r.expires_at),
        }));
    }

    async function extendFormSessionUntil(id: string, until: Date): Promise<number> {
        if (!id || !(until instanceof Date) || Number.isNaN(until.getTime())) return 0;
        await ready();
        return changed(await db.query(
            `UPDATE automation_form_sessions SET expires_at = GREATEST(expires_at, $2::timestamptz)
              WHERE id = $1 AND expires_at > NOW()`,
            [id, until.toISOString()],
        ));
    }

    async function claimFormPageNotice({ automationId, runId, recipient }: { automationId: string; runId: string; recipient: string }): Promise<string | null> {
        if (!automationId || !runId || !recipient) return null;
        await ready();
        const id = newId();
        const { rows } = await db.query(
            `INSERT INTO automation_notification_events (id, automation_id, run_id, event, recipient_user_id, channel, urgency, created_at, bundled)
             SELECT $1, $2, $3, $4, $5, 'bell', 'normal', NOW(), FALSE
              WHERE NOT EXISTS (SELECT 1 FROM automation_notification_events WHERE run_id = $3 AND event = $4)
             RETURNING id`,
            [id, automationId, runId, FORM_PAGE_DUE_EVENT, recipient],
        );
        return rows.length ? String(rows[0].id) : null;
    }

    async function settleFormPageNotice(claimId: string, { bell, email }: { bell: boolean; email: boolean | null }): Promise<void> {
        if (!claimId) return;
        await ready();
        if (bell) {
            await db.query(`UPDATE automation_notification_events SET delivered_at = created_at WHERE id = $1`, [claimId]);
        }
        if (email === null) return;
        await db.query(
            `INSERT INTO automation_notification_events (id, automation_id, run_id, event, recipient_user_id, channel, urgency, created_at, delivered_at, bundled)
             SELECT $2, automation_id, run_id, event, recipient_user_id, 'email', urgency, created_at,
                    CASE WHEN $3::boolean THEN created_at ELSE NULL END, FALSE
               FROM automation_notification_events WHERE id = $1`,
            [claimId, newId(), email],
        );
    }

    return { formSessionsOfJourney, extendFormSessionUntil, claimFormPageNotice, settleFormPageNotice };
}

function defaultId(): string {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    return `ane_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
