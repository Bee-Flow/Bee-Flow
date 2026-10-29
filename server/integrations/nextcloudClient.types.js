// @typecheck strict
'use strict';
// Types only (no runtime exports): the shapes nextcloudClient.js hands back.

/**
 * How a tool reaches Nextcloud: base URL, the user's uid, a ready `fetch` and the
 * message to show when it is refused. The rest depends on `mode`.
 *
 * @typedef {{ mode?: string, baseUrl: string, publicBaseUrl?: string, uid?: string,
 *   session?: Partial<Express.Session> | null, username?: string, password?: string,
 *   fetch: (url: string, options?: any) => Promise<any>, authError: string }} NcAuth
 */

module.exports = {};
