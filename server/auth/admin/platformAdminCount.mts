/**
 * Does a change to one account leave the server without a platform admin?
 *
 * A platform admin is an account with `users.role === 'admin'` that can still
 * sign in (no status, or 'active': the same reading as
 * orgAdminGuards.isActiveUserStatus). The operator account from setup is one
 * of them. Its row normally exists (finalizeLogin writes it with role 'admin',
 * and PUT /users/:id refuses to downgrade it); when the row is missing it still
 * counts as long as it can sign in from the stored config.
 *
 * Every instance-wide setting, and the platform role itself, is behind a
 * platform admin, so a server without one has no in-app way back. The user
 * routes ask this before a demotion, a suspension or a delete of a platform
 * admin. Pure: the caller hands in the rows and the config facts.
 */

export interface AccountRow {
    id?: string | null;
    role?: string | null;
    status?: string | null;
}

export interface AccountChange {
    /** The account being changed. */
    id: string;
    /** The platform role after the change; undefined keeps the stored one. */
    role?: unknown;
    /** The status after the change; undefined keeps the stored one. */
    status?: unknown;
    /** The account is deleted. */
    deleted?: boolean;
}

export interface CountOptions {
    /** Is this account the operator from setup? (auth/platformOperator.js) */
    isOperator: (id: string) => boolean;
    /** The operator can sign in from the stored config (setup is done). */
    operatorSignsInFromConfig: boolean;
}

export const LAST_PLATFORM_ADMIN_REFUSAL = Object.freeze({
    error: 'This change would leave the server without a platform administrator. Make another active account a platform administrator first.',
    code: 'last_platform_admin',
});

function isActiveStatus(status: unknown): boolean {
    return !status || status === 'active';
}

/** Can this row act as a platform admin right now? */
export function isActivePlatformAdmin(row: AccountRow | null | undefined): boolean {
    return !!row && row.role === 'admin' && isActiveStatus(row.status);
}

/**
 * True when `change` takes away the last account that can act as a platform
 * admin. A change that leaves the account a platform admin, or touches an
 * account that is not one, is never refused.
 */
export function leavesNoPlatformAdmin(rows: readonly AccountRow[], change: AccountChange, opts: CountOptions): boolean {
    const target = rows.find((r) => r?.id === change.id);
    if (!isActivePlatformAdmin(target)) return false;
    if (!change.deleted) {
        const after: AccountRow = {
            id: change.id,
            role: change.role === undefined ? target?.role : String(change.role),
            status: change.status === undefined ? target?.status : String(change.status ?? ''),
        };
        if (isActivePlatformAdmin(after)) return false;
    }
    const others = rows.filter((r) => r?.id !== change.id && isActivePlatformAdmin(r)).length;
    const operatorHasRow = rows.some((r) => typeof r?.id === 'string' && opts.isOperator(r.id));
    const operatorFromConfig = !operatorHasRow && opts.operatorSignsInFromConfig ? 1 : 0;
    return others + operatorFromConfig === 0;
}
