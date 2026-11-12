/**
 * The daily budget of an organisation for the e-mailed one-time code of a
 * pending Nextcloud binding: codes sent and attempts made, counted over every
 * pending row of the organisation and per calendar day, so a row that runs
 * out and starts over does not start a new budget. Past the budget only a
 * pairing code links a Nextcloud to the organisation that day.
 *
 *   NC_VERIFICATION_DAILY_ATTEMPTS  attempts per organisation per day (default 50, 0 = unlimited)
 *   NC_VERIFICATION_DAILY_SENDS     codes sent per organisation per day (default 20, 0 = unlimited)
 *
 * The table is created with the pending bindings (schemaMigrations.js).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { getOne } = nodeRequire('../../db') as { getOne: (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null | undefined> };

export type DailyKind = 'attempts' | 'sends';

function envCap(name: string, fallback: number): number {
    const n = Number.parseInt(String(process.env[name] ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The cap for one kind; 0 = unlimited. */
export function dailyCap(kind: DailyKind): number {
    return kind === 'attempts' ? envCap('NC_VERIFICATION_DAILY_ATTEMPTS', 50) : envCap('NC_VERIFICATION_DAILY_SENDS', 20);
}

/**
 * Count one attempt or send for the organisation today; false (nothing
 * counted) once today's budget is spent. One statement, so concurrent
 * requests cannot overshoot it.
 */
export async function takeDailyNcVerification(orgId: string, kind: DailyKind): Promise<boolean> {
    const cap = dailyCap(kind);
    if (cap === 0) return true;
    if (!orgId) return false;
    const col = kind === 'attempts' ? 'attempts' : 'sends';
    const row = await getOne(
        `INSERT INTO nc_verification_daily (org_id, day, attempts, sends)
         VALUES ($1, CURRENT_DATE, $2, $3)
         ON CONFLICT (org_id, day) DO UPDATE SET ${col} = nc_verification_daily.${col} + 1
           WHERE nc_verification_daily.${col} < $4
         RETURNING ${col} AS n`,
        [orgId, col === 'attempts' ? 1 : 0, col === 'sends' ? 1 : 0, cap],
    );
    return !!row;
}
