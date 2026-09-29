/**
 * Building the URLs that turn a file on this machine into a file on a server.
 *
 * Three different URLs are needed and they are not interchangeable:
 *
 *   - the **WebDAV** URL is what the Bee Flow server fetches with the user's
 *     app password (see server/integrations/nextcloudFiles/webdav.js). It is
 *     keyed by the DAV user, which for an SSO or LDAP account is not the login
 *     name — getting this wrong produces a 404 that looks like a permissions
 *     problem;
 *   - the **web** URL is what "Open in Nextcloud" opens in a browser;
 *   - the **private link** is the permanent one that survives a rename, and
 *     only the running desktop client can produce it, because it needs the
 *     file id (see socketApi.ts).
 */

import type { NextcloudAccount } from '../../shared/types.ts';
import { normaliseRemotePath } from './clientConfig.ts';

/**
 * Percent-encode a path while keeping its separators.
 *
 * `encodeURIComponent` on the whole path would turn every `/` into `%2F` and
 * produce a URL that resolves to one very oddly named file in the root.
 */
export function encodeRemotePath(remotePath: string): string {
    return normaliseRemotePath(remotePath)
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

/** The DAV user for an account — `dav_user` when present, else the login name. */
export function davUserOf(account: Pick<NextcloudAccount, 'user' | 'davUser'>): string {
    return account.davUser || account.user;
}

/** `https://cloud.example.com/remote.php/dav/files/tom/Projecten/nota.pdf` */
export function webdavUrl(account: Pick<NextcloudAccount, 'url' | 'user' | 'davUser'>, remotePath: string): string {
    const base = account.url.replace(/\/+$/, '');
    const user = encodeURIComponent(davUserOf(account));
    const path = encodeRemotePath(remotePath);
    return `${base}/remote.php/dav/files/${user}${path === '/' ? '' : path}`;
}

/**
 * A URL that opens the file, or its folder, in the Nextcloud Files app.
 *
 * `?dir=<folder>&scrollto=<name>` is used rather than the newer
 * `/apps/files/files/<fileid>` form because a file id is only knowable from the
 * running desktop client or an extra WebDAV round trip, and this link has to
 * work from a context menu with neither. Nextcloud has understood the query
 * form since before this client existed and still does.
 */
export function webUrl(account: Pick<NextcloudAccount, 'url'>, remotePath: string, isDirectory: boolean): string {
    const base = account.url.replace(/\/+$/, '');
    const path = normaliseRemotePath(remotePath);
    if (isDirectory) {
        return `${base}/index.php/apps/files/?dir=${encodeURIComponent(path)}`;
    }
    const cut = path.lastIndexOf('/');
    const dir = cut <= 0 ? '/' : path.slice(0, cut);
    const name = path.slice(cut + 1);
    return `${base}/index.php/apps/files/?dir=${encodeURIComponent(dir)}&scrollto=${encodeURIComponent(name)}`;
}

/** Where Login Flow v2 starts. Nextcloud has served this since 16. */
export function loginFlowUrl(serverUrl: string): string {
    return `${serverUrl.replace(/\/+$/, '')}/index.php/login/v2`;
}

/** The OCS endpoint that confirms who an app password belongs to. */
export function userMetadataUrl(serverUrl: string): string {
    return `${serverUrl.replace(/\/+$/, '')}/ocs/v2.php/cloud/user?format=json`;
}
