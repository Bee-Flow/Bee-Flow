/**
 * Organisation, people, Privacy Shield and data-subject requests.
 *
 * Paths are the full client-visible ones: the roster and the organisation are
 * under `/auth/…` (auth/admin/*), the rest under `/api/…`. Several answer 403
 * by design — org-admin and `admin_compliance` gates — and go through
 * `optional`, so a refusal is a null the screen renders, not an error.
 */

import { api } from '@/core/api/client';
import { optional } from '@/core/api/optional';

import {
    readDsrRequests,
    readDsrSubmit,
    readGithubStatus,
    readGroups,
    readGuardStatus,
    readLicenseHealth,
    readOrganization,
    readOrgMembers,
    readOrgShield,
    readUserShield,
} from './readers';
import type {
    DsrRequest,
    DsrSubmitResponse,
    GuardStatus,
    LicenseHealth,
    Organization,
    OrgMember,
    OrgPatch,
    OrgShield,
    UserGroup,
    UserShield,
} from '../model/types';

// ── Organisation and people ────────────────────────────────────────────

export async function getOrganization(id: string, signal?: AbortSignal): Promise<Organization | null> {
    return optional(async () =>
        readOrganization(
            await api.get<unknown>(`/auth/organizations/${encodeURIComponent(id)}`, { signal }),
        ),
    );
}

/** A partial patch: the server skips an absent key and refuses an unknown one. */
export async function updateOrganization(id: string, patch: OrgPatch): Promise<void> {
    await api.put(`/auth/organizations/${encodeURIComponent(id)}`, patch);
}

/** Whether the caller has connected GitHub (the web shows GitHub Sync only then). */
export async function getGithubConnected(signal?: AbortSignal): Promise<boolean> {
    const raw = await optional(() => api.get<unknown>('/api/integrations/github/status', { signal }));
    return readGithubStatus(raw);
}

export async function listOrgMembers(signal?: AbortSignal): Promise<OrgMember[]> {
    return readOrgMembers(await api.get<unknown>('/auth/users', { signal }));
}

export async function listGroups(signal?: AbortSignal): Promise<UserGroup[]> {
    return readGroups(await api.get<unknown>('/auth/groups', { signal }));
}

/** Licence refresher and dunning counts; org-admin only, a refusal reads as null. */
export async function getLicenseHealth(signal?: AbortSignal): Promise<LicenseHealth | null> {
    return optional(async () => readLicenseHealth(await api.get<unknown>('/api/license/health', { signal })));
}

// ── Privacy Shield ─────────────────────────────────────────────────────

export async function getUserShield(signal?: AbortSignal): Promise<UserShield | null> {
    return readUserShield(await api.get<unknown>('/api/org-privacy-shield/user/me', { signal }));
}

/** PUT replaces the stored document, so `next` must be the whole of it. */
export async function saveUserShield(next: UserShield): Promise<void> {
    await api.put('/api/org-privacy-shield/user/me', next);
}

export async function getGuardStatus(signal?: AbortSignal): Promise<GuardStatus | null> {
    return readGuardStatus(
        await api.get<unknown>('/api/org-privacy-shield/user/guard-status', { signal }),
    );
}

export async function getOrgShield(orgId: string, signal?: AbortSignal): Promise<OrgShield | null> {
    return optional(async () =>
        readOrgShield(
            await api.get<unknown>(`/api/org-privacy-shield/${encodeURIComponent(orgId)}`, { signal }),
        ),
    );
}

// ── Compliance / DSR ───────────────────────────────────────────────────

/** Admin view. Needs `admin_compliance`; a refusal reads as null so a
 *  member's screen simply omits the card. */
export async function listDsrRequests(signal?: AbortSignal): Promise<DsrRequest[] | null> {
    return optional(async () =>
        readDsrRequests(await api.get<unknown>('/api/dsr/requests', { signal })),
    );
}

/**
 * File a data-subject request against your own account.
 *
 * Deliberately the PUBLIC endpoint: GDPR Art. 12 requires the channel to stay
 * reachable, so it is mounted without the enterprise gate and never 403s on a
 * community install. It is rate-limited to five per hour per IP, and the org
 * is derived from the email server-side — a client-supplied organization_id is
 * ignored.
 */
export async function submitDsrRequest(body: {
    subject_email: string;
    request_type: string;
    notes?: string;
}): Promise<DsrSubmitResponse | null> {
    return readDsrSubmit(await api.post<unknown>('/api/dsr/requests', body));
}
