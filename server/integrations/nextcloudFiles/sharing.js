// @typecheck noImplicitAny
/**
 * Shares over the files_sharing OCS API — public links, user/group/email
 * shares, listing, updating and revoking — plus the group lookup a group share
 * needs first.
 */

const { extractReason } = require('../nextcloudHttpError');

// Nextcloud sends a share id as a string ("12"); update_share and delete_share
// take a number. Hand the number back everywhere so ids round-trip.
/**
 * @param {string | number | null} id
 */
function toShareId(id) {
    if (id == null || id === '') return null;
    const n = Number(id);
    return Number.isInteger(n) ? n : id;
}

// An OCS failure as one readable line: Nextcloud's own reason (ocs.meta.message,
// in the server's language) instead of the raw JSON body.
/**
 * @param {Response} res
 * @param {string} what
 */
async function shareFailure(res, what) {
    const reason = extractReason(await res.text().catch(() => ''));
    return { error: `${what} failed (${res.status})${reason ? `: ${reason}` : ''}` };
}

// Returns undefined when the tool belongs to another Nextcloud file family, so
// the facade can hand it to the next handler.
/**
 * @param {string} toolName
 * @param {{ path?: string, shareId?: string | number, shareWith?: string, permissions?: number, password?: string, expireDate?: string, note?: string, search?: string, limit?: number, shared_with_me?: boolean }} args
 * @param {import('./webdav').FilesToolCtx} ctx
 */
async function executeShareTool(toolName, args, ctx) {
    const { baseUrl, ncFetch, authError } = ctx;

    switch (toolName) {
        case 'nextcloud_list_groups': {
            const limit = Math.min(Math.max(args.limit || 100, 1), 500);
            const params = new URLSearchParams({ format: 'json', limit: String(limit) });
            if (args.search) params.set('search', String(args.search));
            const res = await ncFetch(`${baseUrl}/ocs/v2.php/cloud/groups?${params.toString()}`, {
                headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 403) {
                return { error: 'Listing groups requires more permission than this Nextcloud account has.' };
            }
            if (!res.ok) return { error: `Could not list Nextcloud groups (${res.status})` };
            const body = await res.json().catch(/** @returns {null} */ () => null);
            const groups = body?.ocs?.data?.groups || [];
            return { count: groups.length, groups };
        }

        case 'nextcloud_create_share': {
            if (!args.path) return { error: 'path is required' };
            const params = new URLSearchParams();
            params.set('path', args.path);
            params.set('shareType', '3'); // 3 = public link
            params.set('permissions', '1'); // 1 = read
            if (args.password) params.set('password', args.password);
            if (args.expireDate) params.set('expireDate', args.expireDate);
            const url = `${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`;
            const res = await ncFetch(url, {
                method: 'POST',
                headers: {
                    'OCS-APIRequest': 'true',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                body: params.toString(),
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return shareFailure(res, 'Share creation');
            const data = await res.json();
            const meta = data?.ocs?.meta;
            const share = data?.ocs?.data;
            if (meta?.statuscode && meta.statuscode >= 400) {
                return { error: `Nextcloud rejected share: ${meta.message || 'unknown error'}` };
            }
            return {
                success: true,
                url: share?.url || null,
                token: share?.token || null,
                id: toShareId(share?.id),
                path: args.path,
                expiration: share?.expiration || null,
            };
        }

        case 'nextcloud_share_with_user':
        case 'nextcloud_share_with_group':
        case 'nextcloud_share_by_email': {
            if (!args.path || !args.shareWith) return { error: 'path and shareWith are required' };
            const shareType = toolName === 'nextcloud_share_with_user' ? 0
                : toolName === 'nextcloud_share_with_group' ? 1
                : 4;
            const params = new URLSearchParams();
            params.set('path', args.path);
            params.set('shareType', String(shareType));
            params.set('shareWith', args.shareWith);
            if (args.permissions !== undefined) params.set('permissions', String(args.permissions));
            if (args.password) params.set('password', args.password);
            if (args.expireDate) params.set('expireDate', args.expireDate);
            if (args.note) params.set('note', args.note);
            const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`, {
                method: 'POST',
                headers: {
                    'OCS-APIRequest': 'true',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                body: params.toString(),
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return shareFailure(res, 'Share creation');
            const data = await res.json().catch(() => ({}));
            const meta = data?.ocs?.meta;
            const share = data?.ocs?.data;
            if (meta?.statuscode && meta.statuscode >= 400) {
                return { error: `Nextcloud rejected share: ${meta.message || 'unknown error'}` };
            }
            return {
                success: true,
                id: toShareId(share?.id),
                shareId: toShareId(share?.id),
                shareType,
                shareWith: args.shareWith,
                path: args.path,
                permissions: share?.permissions,
                expiration: share?.expiration || null,
            };
        }

        case 'nextcloud_list_shares': {
            const params = new URLSearchParams({ format: 'json' });
            if (args.path) params.set('path', args.path);
            if (args.shared_with_me) params.set('shared_with_me', 'true');
            const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?${params.toString()}`, {
                headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return shareFailure(res, 'Share list');
            const data = await res.json().catch(() => ({}));
            const shares = (data?.ocs?.data || []).map((/** @type {{ id: string, share_type: number, share_with: string, share_with_displayname: string, path: string, file_target: string, permissions: number, expiration: string | null, token: string | null, url?: string, stime: number, note: string }} */ s) => ({
                id: toShareId(s.id),
                shareType: s.share_type,
                shareWith: s.share_with,
                shareWithDisplayName: s.share_with_displayname,
                path: s.path,
                fileTarget: s.file_target,
                permissions: s.permissions,
                expiration: s.expiration,
                token: s.token,
                url: s.url,
                stime: s.stime,
                note: s.note,
            }));
            return { count: shares.length, shares };
        }

        case 'nextcloud_update_share': {
            if (!args.shareId) return { error: 'shareId is required' };
            // Run each provided field through its own PUT — Nextcloud expects
            // one property per request on this endpoint.
            const fields = [];
            if (args.permissions !== undefined) fields.push(['permissions', String(args.permissions)]);
            if (args.password !== undefined) fields.push(['password', args.password]);
            if (args.expireDate !== undefined) fields.push(['expireDate', args.expireDate]);
            if (args.note !== undefined) fields.push(['note', args.note]);
            if (fields.length === 0) return { error: 'no fields to update' };
            for (const [key, val] of fields) {
                const params = new URLSearchParams();
                params.set(key, val);
                const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares/${encodeURIComponent(args.shareId)}?format=json`, {
                    method: 'PUT',
                    headers: {
                        'OCS-APIRequest': 'true',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json',
                    },
                    body: params.toString(),
                });
                if (res.status === 401) return { error: authError };
                if (!res.ok) return shareFailure(res, `Share update (${key})`);
            }
            return { success: true, shareId: toShareId(args.shareId) };
        }

        case 'nextcloud_delete_share': {
            if (!args.shareId) return { error: 'shareId is required' };
            const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares/${encodeURIComponent(args.shareId)}?format=json`, {
                method: 'DELETE',
                headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Share not found: ${args.shareId}` };
            if (!res.ok) return shareFailure(res, 'Share delete');
            return { success: true, shareId: args.shareId };
        }

        default:
            return undefined;
    }
}

module.exports = { executeShareTool, toShareId };
