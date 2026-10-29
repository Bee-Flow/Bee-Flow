// @typecheck strict
/**
 * Nextcloud Talk — the OCS endpoints and the response reader every Talk tool
 * module shares (nextcloudTalkTools.js, nextcloudTalkChat.js).
 */

'use strict';

/**
 * The body as JSON, or as the raw text when it is not JSON ('' when unreadable).
 * @param {{ text: () => Promise<string> }} res
 */
async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

/** @param {string} baseUrl */
function v4(baseUrl) { return `${baseUrl}/ocs/v2.php/apps/spreed/api/v4`; }
/** @param {string} baseUrl */
function v1(baseUrl) { return `${baseUrl}/ocs/v2.php/apps/spreed/api/v1`; }

const COMMON_HEADERS = {
    'OCS-APIRequest': 'true',
    'Accept': 'application/json',
};

module.exports = { readJsonSafe, v4, v1, COMMON_HEADERS };
