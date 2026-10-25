// @typecheck strict
'use strict';
// Types only (no runtime exports): the shapes nextcloudClient.js hands back.

/**
 * How a tool reaches Nextcloud: base URL, the user's uid, a ready `fetch` and the
 * message to show when it is refused. The rest depends on `mode`.
 *
 * @typedef {object} NcAuth
 * @property {string} [mode]
 * @property {string} baseUrl
 * @property {string} [publicBaseUrl]
 * @property {string} [uid]
 * @property {any} [session]
 * @property {string} [username]
 * @property {string} [password]
 * @property {(url: string, options?: any) => Promise<any>} fetch
 * @property {string} authError
 */

module.exports = {};
