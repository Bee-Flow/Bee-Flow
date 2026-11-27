// @typecheck strict
'use strict';
/**
 * The raw failure texts the Nextcloud client actually produces, each with the code
 * utils/nextcloudErrorClassifier.js must give it: [code, text]. Shared by
 * nextcloudErrorClassifier.test.js and its automation module's half
 * (nextcloudErrorClassifier.automation.test.js).
 */

/** @type {[string, string][]} */
const cases = [
    ['NOT_CONNECTED', 'NOT_CONNECTED'],
    ['NOT_CONNECTED', 'Nextcloud not connected. Log in via Nextcloud OAuth, or add your username and app password in Settings → Connections.'],
    ['SESSION_EXPIRED', 'Nextcloud token refresh failed — user must re-authenticate'],
    ['SESSION_EXPIRED', 'Nextcloud download failed (401)'],
    ['CONNECTOR_UNREACHABLE', 'Could not reach Nextcloud through the ExApp'],
    ['THROTTLED', 'Nextcloud PROPFIND failed (429): Too Many Requests'],
    ['THROTTLED', 'Deck request failed (503): rate limit reached'],
    ['NEXTCLOUD_MAINTENANCE', 'Nextcloud is in maintenance mode (503) during board list. Try again when the maintenance or upgrade is finished.'],
    ['NEXTCLOUD_MAINTENANCE', 'Nextcloud PROPFIND failed (503): <s:exception>OCA\\DAV\\Connector\\Sabre\\Exception\\ServerMaintenanceMode</s:exception><s:message>System is in maintenance mode.</s:message>'],
    ['TEMPORARILY_UNAVAILABLE', 'Nextcloud download failed (503)'],
    ['TEMPORARILY_UNAVAILABLE', 'Nextcloud could not be reached or is temporarily unavailable (503) during team lookup. Try again shortly.'],
    ['PROXY_ANSWERED', 'A proxy in front of Nextcloud answered instead of Nextcloud (403) during team list: it blocked the request (a firewall or bot rule). Ask the Nextcloud admin to let the Bee Flow calls through.'],
    ['PROXY_ANSWERED', 'A proxy in front of Nextcloud answered instead of Nextcloud (522) during download: the proxy got no answer from Nextcloud. Check that Nextcloud is up and reachable from the proxy.'],
    ['FILE_LOCKED', '/Docs/report.docx is locked in Nextcloud (423): it is open in an editor or locked by another user. Try again later, or ask them to unlock it.'],
    ['FILE_LOCKED', 'MOVE failed (423): <s:exception>OCA\\DAV\\Connector\\Sabre\\Exception\\FileLocked</s:exception><s:message>"a.docx" is locked</s:message>'],
    ['FILE_LOCKED', 'Delete failed (423)'],
    ['FILE_LOCKED', 'Could not write the file: "a.docx" is locked'],
    ['QUOTA_EXCEEDED', 'Not enough storage in Nextcloud for /Docs/big.zip (507): the quota of the account or the folder is used up.'],
    ['QUOTA_EXCEEDED', 'Upload failed (507): <s:exception>Sabre\\DAV\\Exception\\InsufficientStorage</s:exception><s:message>Insufficient space in /Docs</s:message>'],
    ['QUOTA_EXCEEDED', 'Upload of the file stopped: Insufficient storage'],
    ['NO_ACCESS', 'Permission denied in Nextcloud for /HR/a.pdf (403): the account may not change this file or folder. A read-only share, a team folder permission or a file access control rule can block it.'],
    ['NO_ACCESS', 'Upload failed (403): <s:exception>Sabre\\DAV\\Exception\\Forbidden</s:exception><s:message>Access denied by a file access control rule</s:message>'],
    ['NOT_FOUND', 'File not found: /Invoices/507/a.pdf'],
    ['NOT_FOUND', 'File not found: /Rooms/423/plan.pdf'],
    ['NO_ACCESS', 'Upload failed (403): the folder is locked down, quota exceeded elsewhere'],
    ['TIMEOUT', 'The request timed out'],
    ['ALREADY_EXISTS', 'Folder already exists: /Invoices'],
    ['PARENT_MISSING', 'Parent folder for /Invoices/2026/a.pdf does not exist. Create it first with nextcloud_create_folder.'],
    ['NO_ACCESS', 'Nextcloud PROPFIND failed (403): <s:exception>Sabre\\DAV\\Exception\\Forbidden</s:exception>'],
    ['NO_ACCESS', 'Upload failed (403): forbidden'],
    ['NO_ACCESS', 'Permission denied on /HR'],
    ['APP_DISABLED', 'Deck request failed (403)'],
    ['APP_DISABLED', 'The Notes app is not enabled for this user'],
    ['NOT_FOUND', 'File not found: /Invoices/missing.pdf'],
    ['NOT_FOUND', 'Folder not found: /Nope'],
    ['MISSING_FIELD', 'path is required'],
    ['UNKNOWN', 'Something odd happened'],
];

module.exports = { cases };
