// @typecheck
/**
 * CalDAV plumbing for the Nextcloud tasks tools: multistatus parsing, list
 * discovery (supportsTasks / writable) and readable errors for failed writes.
 */

const { XMLParser } = require('fast-xml-parser');
const { extractReason } = require('./nextcloudHttpError');
const { hasWritePrivilege } = require('./nextcloudDavProps');

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
    htmlEntities: true,
});

const PROPFIND_LISTS = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <c:supported-calendar-component-set/>
    <d:current-user-privilege-set/>
    <cs:getctag/>
  </d:prop>
</d:propfind>`;

function parseMultistatusResponses(xml) {
    const parsed = xmlParser.parse(xml);
    const ms = parsed?.multistatus;
    if (!ms) return [];
    const list = Array.isArray(ms.response) ? ms.response : (ms.response ? [ms.response] : []);
    return list.map((r) => {
        const propstats = Array.isArray(r.propstat) ? r.propstat : (r.propstat ? [r.propstat] : []);
        const props = {};
        for (const ps of propstats) {
            const status = ps.status || '';
            if (status && !/\b2\d\d\b/.test(status)) continue;
            Object.assign(props, ps.prop || {});
        }
        return { href: r.href || '', props };
    });
}

function supportsVTodo(props) {
    const set = props['supported-calendar-component-set'];
    // RFC 4791: a calendar without the property accepts every component type.
    if (!set) return true;
    if (!set.comp) return false;
    const comps = Array.isArray(set.comp) ? set.comp : [set.comp];
    return comps.some((c) => c && (c['@_name'] === 'VTODO' || c.name === 'VTODO'));
}

function isCalendarCollection(props) {
    const rt = props.resourcetype;
    return !!rt && typeof rt === 'object' && rt.calendar !== undefined;
}

/** Every calendar collection, with whether it can hold tasks and whether the user may write to it. */
function parsePropfindLists(xml, uid) {
    const root = `/remote.php/dav/calendars/${decodeURIComponent(uid)}`;
    const lists = [];
    for (const { href, props } of parseMultistatusResponses(xml)) {
        if (!href) continue;
        if (!isCalendarCollection(props)) continue;
        const supportsTasks = supportsVTodo(props);
        const decoded = decodeURIComponent(href);
        if (decoded.replace(/\/+$/, '') === root) continue;
        const slug = decoded.replace(/\/+$/, '').split('/').pop();
        lists.push({ slug, displayName: props.displayname || slug, href, supportsTasks, writable: hasWritePrivilege(props) });
    }
    return lists;
}

async function fetchLists(ncFetch, root, uid, authError) {
    const res = await ncFetch(`${root}/`, {
        method: 'PROPFIND',
        headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_LISTS,
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Task list enumeration failed (${res.status})` };
    return { lists: parsePropfindLists(await res.text(), uid) };
}

/** Readable text for a failed task write; never raw XML, and no server detail on a 5xx. */
function taskWriteError(action, list, status, body) {
    if (status >= 500) return `Task ${action} failed (${status}): the Nextcloud server reported an internal error.`;
    const reason = extractReason(body);
    if (status === 403 && /InvalidComponentType|does not support/i.test(body || '')) {
        return `Task list "${list}" does not support tasks (no VTODO). Use nextcloud_tasks_list_lists and pick a list with supportsTasks and writable true.`;
    }
    if (status === 403) {
        const why = reason ? `: ${reason}` : '';
        return `Task list "${list}" is read-only or you lack permission to change it (403${why}). Use nextcloud_tasks_list_lists and pick a list with writable true.`;
    }
    return `Task ${action} failed (${status})${reason ? `: ${reason}` : ''}`;
}

module.exports = { parseMultistatusResponses, fetchLists, taskWriteError };
