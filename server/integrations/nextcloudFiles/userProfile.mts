/**
 * nextcloud_get_user: a Nextcloud account's profile by uid, through the
 * provisioning API (`GET /ocs/v2.php/cloud/users/<uid>`).
 *
 *   { uid, displayName, email, groups[], manager[], language }
 *
 * The call runs as the automation's owner (or the chat user), so Nextcloud
 * decides what it shows: everyone reads their own account, an admin or group
 * admin reads the accounts they manage, and anyone else gets "not found". That
 * refusal comes back as a plain error naming the way round it (the system
 * address book), never as a crash.
 *
 * `manager` is a list: Nextcloud stores manager uids as a list and older
 * versions answer a single string; both shapes are read. A missing field is
 * an empty list or null, never a guess.
 *
 * This is an inbound read: the profile lands in the run output (and the run's
 * retention applies), it is sent nowhere.
 */

type NcResponse = { ok: boolean; status: number; text: () => Promise<string> };
type NcFetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<NcResponse>;

export interface UserProfileCtx { baseUrl: string; ncFetch: NcFetch; authError: string }
export interface UserProfile {
    uid: string;
    displayName: string | null;
    email: string | null;
    groups: string[];
    manager: string[];
    language: string | null;
}

const OCS_HEADERS = { 'OCS-APIRequest': 'true', Accept: 'application/json' };
/** OCS status codes for "you may not see this user" and "no such user" (v1 numbering, also in v2 bodies). */
const OCS_NOT_VISIBLE = new Set([403, 404, 997, 998]);
const UID_MAX = 255;

function str(v: unknown): string | null {
    return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function stringList(v: unknown): string[] {
    if (typeof v === 'string') return v.trim() ? [v] : [];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    // Some versions answer a JSON object for an array (PHP's associative arrays).
    if (v && typeof v === 'object') return stringList(Object.values(v));
    return [];
}

/** The profile out of the OCS `data` block (exported for tests). */
export function toUserProfile(uid: string, data: Record<string, unknown>): UserProfile {
    return {
        uid: str(data.id) ?? uid,
        displayName: str(data.displayname) ?? str(data['display-name']) ?? null,
        email: str(data.email),
        groups: stringList(data.groups),
        manager: stringList(data.manager),
        language: str(data.language),
    };
}

function notVisible(uid: string): { error: string } {
    return {
        error: `Nextcloud does not show the profile of "${uid}" to this account: a user reads their own profile, `
            + 'and admins and group admins read the accounts they manage. For an e-mail address, '
            + 'nextcloud_contacts_search on the system address book is the way round.',
    };
}

/** A uid as Nextcloud allows it: no slashes, no control characters, not too long. */
function validUid(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const uid = value.trim();
    if (!uid || uid.length > UID_MAX || uid.includes('/') || uid.includes('\\')) return null;
    for (let i = 0; i < uid.length; i++) if (uid.charCodeAt(i) < 0x20 || uid.charCodeAt(i) === 0x7f) return null;
    return uid;
}

function parseBody(text: string): { statuscode: number | null; data: Record<string, unknown> | null } {
    try {
        const body = JSON.parse(text) as { ocs?: { meta?: { statuscode?: unknown }; data?: unknown } };
        const code = Number(body?.ocs?.meta?.statuscode);
        const data = body?.ocs?.data;
        return {
            statuscode: Number.isFinite(code) ? code : null,
            data: data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null,
        };
    } catch {
        return { statuscode: null, data: null };
    }
}

/** The nextcloud_get_user handler. */
export async function nextcloudGetUser(args: { uid?: unknown }, ctx: UserProfileCtx): Promise<UserProfile | { error: string }> {
    const uid = validUid(args.uid);
    if (!uid) return { error: 'uid is required: the Nextcloud user id (not the display name), without slashes.' };
    const res = await ctx.ncFetch(`${ctx.baseUrl}/ocs/v2.php/cloud/users/${encodeURIComponent(uid)}?format=json`, { headers: OCS_HEADERS });
    if (res.status === 401) return { error: ctx.authError };
    const { statuscode, data } = parseBody(await res.text().catch(() => ''));
    if (OCS_NOT_VISIBLE.has(res.status) || (statuscode !== null && OCS_NOT_VISIBLE.has(statuscode))) return notVisible(uid);
    if (!res.ok) return { error: `Could not read the Nextcloud user "${uid}" (${res.status})` };
    if (!data) return { error: `Nextcloud answered without a profile for "${uid}".` };
    return toUserProfile(uid, data);
}
