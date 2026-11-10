/**
 * Who a Teams import runs for, and with which Microsoft session: the access
 * half of teamsAutoImport.js, which passes its own collaborators in (so its
 * init() seam reaches this code too).
 *
 *   discoverySession(d, userId, orgId)  the session discovery lists the calendar with, or null;
 *                                       every way to null is the user's skip state
 *   ownerBarredReason(d, job)           why a claimed job's owner may not get a note now, or null
 *   claimSession(d, job)                the session a claimed job runs with, or null (park it)
 *
 * Token source: the user's own delegated grant with the Teams scopes first.
 * Without one, the organisation app token of option B (teamsAppImport/), only
 * for a user it covers, decided again at discovery and at every job claim.
 */

import { createRequire } from 'node:module';
import type { TeamsSkipReason } from './teamsImportSkipState.mts';
import type { ResolvedAppSession } from './teamsAppImport/appToken.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log.js') as { warn: (message: string) => void };

type ProviderAuth = { scope?: string | null };

/** The collaborators of teamsAutoImport.js this module calls. */
export interface TeamsImportAccessDeps {
    hasCapability(capId: string, ctx: { userId: string; orgId: string | null }): Promise<boolean>;
    skipState: {
        recordSkip(userId: string, orgId: string | null, reason: TeamsSkipReason, missingPermissions?: string[]): Promise<void>;
        clearSkip(userId: string): Promise<void>;
    };
    automationAuth: { getProviderAuth(userId: string, provider: string): Promise<ProviderAuth | null> };
    credentialStore: { getCredential(userId: string, provider: string): Promise<{ status?: string | null } | null> };
    teamsImportStore: { unparkForUser(userId: string): Promise<unknown> };
    appImport: { resolveAppImportSession(userId: string, orgId: string | null, opts?: { fresh?: boolean }): Promise<ResolvedAppSession> };
    resolveMicrosoftSession(session: object, userId?: string | null): Promise<object | null>;
    userStore: { getUser(userId: string): Promise<{ status?: string | null } | null> };
    hasTeamsScopes(scope: string | null | undefined): boolean;
    hasTranscriptScope(scope: string | null | undefined): boolean;
    missingTeamsPermissions(scope: string | null | undefined): string[];
}

export interface ClaimJob { userId: string; orgId: string | null }

/** A Microsoft-only session over a vault credential; refreshes write back to the vault. */
function vaultSession(d: TeamsImportAccessDeps, auth: ProviderAuth, userId: string): Promise<object | null> {
    return d.resolveMicrosoftSession({ automationProviders: { microsoft: auth } }, userId);
}

/**
 * Why getProviderAuth gave no usable Microsoft credential, read from the
 * vault row's status: none stored, expired, revoked, or (an active row whose
 * refresh failed for now) unusable. Null when the row cannot be read: then
 * nothing is recorded, rather than a wrong reason.
 */
async function credentialSkipReason(d: TeamsImportAccessDeps, userId: string): Promise<TeamsSkipReason | null> {
    let cred;
    try {
        cred = await d.credentialStore.getCredential(userId, 'microsoft');
    } catch (err) {
        log.warn(`[TeamsAutoImport] credential status lookup failed for user ${userId}: ${(err as Error).message}`);
        return null;
    }
    if (!cred) return 'no_credential';
    if (cred.status === 'needs_reauth') return 'credential_needs_reauth';
    if (cred.status === 'revoked') return 'credential_revoked';
    return 'session_unavailable';
}

async function unpark(d: TeamsImportAccessDeps, userId: string): Promise<void> {
    try {
        await d.teamsImportStore.unparkForUser(userId);
    } catch (err) {
        log.warn(`[TeamsAutoImport] unpark failed for user ${userId}: ${(err as Error).message}`);
    }
}

/**
 * Option B: the organisation app-token session for a user without a usable
 * delegated grant (teamsAppImport/appToken.mts; coverage is decided again on
 * every call). Null when it cannot be decided: that is a refusal.
 * `fresh`: past every cache (the claim of a job).
 */
async function appImportSession(d: TeamsImportAccessDeps, userId: string, orgId: string | null, opts: { fresh?: boolean } = {}): Promise<ResolvedAppSession | null> {
    try {
        return await d.appImport.resolveAppImportSession(userId, orgId, opts);
    } catch (err) {
        log.warn(`[TeamsAutoImport] organisation app import unavailable for user ${userId}: ${(err as Error).message}`);
        return null;
    }
}

/**
 * The session discovery lists `userId`'s calendar with, or null. Every way to
 * null is remembered as the user's skip state (teamsImportSkipState.mts), and
 * a working session clears it.
 */
export async function discoverySession(d: TeamsImportAccessDeps, userId: string, orgId: string | null): Promise<object | null> {
    // The background path bypasses the route gates: check the licence here.
    if (!await d.hasCapability('meeting_notes', { userId, orgId })) {
        await d.skipState.recordSkip(userId, orgId, 'not_licensed');
        return null;
    }

    const auth = await d.automationAuth.getProviderAuth(userId, 'microsoft');
    if (!auth || !d.hasTeamsScopes(auth.scope)) {
        // No usable delegated grant: the organisation's app token, when it covers this user.
        const app = await appImportSession(d, userId, orgId);
        if (app?.status === 'covered') {
            await unpark(d, userId);
            await d.skipState.clearSkip(userId);
            return app.session;
        }
        if (app?.status === 'token_failed') {
            await d.skipState.recordSkip(userId, orgId, 'app_token_failed');
            return null;
        }
        if (auth) {
            await d.skipState.recordSkip(userId, orgId, 'missing_scopes', d.missingTeamsPermissions(auth.scope));
            return null;
        }
        const reason = await credentialSkipReason(d, userId);
        if (reason) await d.skipState.recordSkip(userId, orgId, reason);
        return null;
    }

    await unpark(d, userId);

    const session = await vaultSession(d, auth, userId);
    if (!session) {
        await d.skipState.recordSkip(userId, orgId, 'session_unavailable');
        return null;
    }
    await d.skipState.clearSkip(userId);
    return session;
}

/**
 * May this job's owner still have a meeting imported? Checked again at claim
 * time, not only at discovery: a job can wait up to 48 h for its recording,
 * and a user deactivated, or an org whose licence lapsed, in that window must
 * not still get a note transcribed, stored and shared.
 * A failed lookup throws: the claim lease retries the job instead of skipping it for good.
 * @returns why not, or null when they may
 */
export async function ownerBarredReason(d: TeamsImportAccessDeps, job: ClaimJob): Promise<string | null> {
    const user = await d.userStore.getUser(job.userId);
    if (!user || (user.status ?? 'active') !== 'active') return 'the account is no longer active';
    if (!await d.hasCapability('meeting_notes', { userId: job.userId, orgId: job.orgId })) return 'Meeting Notes is not licensed for this account';
    return null;
}

/**
 * The session a claimed job runs with, and whether its transcript may be read;
 * null when there is none (the caller parks the job for a reconnect). Option B
 * is decided again now for the job's own organisation: a switch-off, a removed
 * member or a changed tenant since discovery means no app token.
 */
export async function claimSession(d: TeamsImportAccessDeps, job: ClaimJob): Promise<{ session: object; transcriptAllowed: boolean } | null> {
    const auth = await d.automationAuth.getProviderAuth(job.userId, 'microsoft');
    if (!auth || !d.hasTeamsScopes(auth.scope)) {
        const app = await appImportSession(d, job.userId, job.orgId, { fresh: true });
        if (app?.status === 'covered') return { session: app.session, transcriptAllowed: app.transcriptAllowed };
    }
    const session = auth ? await vaultSession(d, auth, job.userId) : null;
    if (!session || !auth) return null;
    return { session, transcriptAllowed: d.hasTranscriptScope(auth.scope) };
}
