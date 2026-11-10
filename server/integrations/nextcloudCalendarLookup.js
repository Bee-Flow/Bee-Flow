// @typecheck strict
/**
 * Where a calendar event lives: the calendar home, the conventional
 * `<UID>.ics` address, and the lookup by UID for an event stored under another
 * file name. Split out of ./nextcloudCalendarTools.js.
 */

const { parseMultistatus } = require('./nextcloudFiles/webdav');
const { calendarUidReport } = require('./nextcloudCalDavQueries');

/**
 * @param {string} baseUrl
 * @param {string | undefined} uid
 */
function calendarsRoot(baseUrl, uid) {
    return `${baseUrl}/remote.php/dav/calendars/${encodeURIComponent(uid || '')}`;
}

/**
 * @param {string} baseUrl
 * @param {string | undefined} uid
 * @param {string | number | boolean} calendar
 * @param {string} eventUid
 */
function eventHref(baseUrl, uid, calendar, eventUid) {
    return `${calendarsRoot(baseUrl, uid)}/${encodeURIComponent(calendar)}/${encodeURIComponent(eventUid)}.ics`;
}

/**
 * The URL of the calendar object that holds `eventUid`, asked from the server,
 * or null. Only an object inside this calendar is accepted.
 * @param {{ baseUrl: string, uid?: string, fetch: import('./nextcloudClient.types').NcAuth['fetch'] }} ctx
 * @param {string} calendar
 * @param {string} eventUid
 * @returns {Promise<string | null>}
 */
async function findEventUrlByUid(ctx, calendar, eventUid) {
    const collection = `${calendarsRoot(ctx.baseUrl, ctx.uid)}/${encodeURIComponent(calendar)}/`;
    const res = await ctx.fetch(collection, {
        method: 'REPORT',
        headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: calendarUidReport(eventUid),
    });
    if (!res.ok) return null;
    const collectionPath = new URL(collection).pathname;
    const davPath = collectionPath.slice(collectionPath.indexOf('/remote.php/dav/'));
    for (const { href } of parseMultistatus(await res.text())) {
        // The href is a server path; a subpath install puts a prefix before /remote.php.
        const at = href.indexOf('/remote.php/dav/');
        if (at === -1) continue;
        const path = href.slice(at);
        const name = path.slice(davPath.length);
        if (!path.startsWith(davPath) || !name || name.includes('/') || name.startsWith('.')) continue;
        return `${ctx.baseUrl}${path}`;
    }
    return null;
}

/**
 * Send a request to an event by UID: first to `<UID>.ics`, and on a 404 to the
 * file the server says the UID lives in.
 * @param {{ baseUrl: string, uid?: string, fetch: import('./nextcloudClient.types').NcAuth['fetch'] }} ctx
 * @param {string} calendar
 * @param {string} eventUid
 * @param {Record<string, unknown>} options
 */
async function fetchEventByUid(ctx, calendar, eventUid, options) {
    const direct = eventHref(ctx.baseUrl, ctx.uid, calendar, eventUid);
    const res = await ctx.fetch(direct, options);
    if (res.status !== 404) return { res, url: direct };
    const url = await findEventUrlByUid(ctx, calendar, eventUid);
    if (!url || url === direct) return { res, url: direct };
    return { res: await ctx.fetch(url, options), url };
}

module.exports = { calendarsRoot, eventHref, fetchEventByUid };
