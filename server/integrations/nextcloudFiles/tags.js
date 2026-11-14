// @typecheck strict
/**
 * System tags — list and create tags, attach or detach them from a file, and
 * find every file carrying one.
 */

const { parseMultistatus, parsePropfind } = require('./webdav');

/**
 * @typedef {{ fileId?: string | number, tagId?: string | number, name?: string, limit?: number, userVisible?: boolean, userAssignable?: boolean }} TagArgs
 * @typedef {(args: TagArgs, ctx: import('./webdav').FilesToolCtx) => Promise<Record<string, any>>} TagHandler
 */

const LIST_TAGS_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <oc:id/>
    <oc:display-name/>
    <oc:user-visible/>
    <oc:user-assignable/>
    <oc:can-assign/>
  </d:prop>
</d:propfind>`;

/** @param {string | number | boolean} v */
const isTrue = (v) => v === 'true' || v === '1' || v === true || v === 1;

/** @type {TagHandler} */
async function listTags(_args, { baseUrl, ncFetch, authError }) {
    const res = await ncFetch(`${baseUrl}/remote.php/dav/systemtags/`, {
        method: 'PROPFIND',
        headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: LIST_TAGS_BODY,
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Tags list failed (${res.status})` };
    const xml = await res.text();
    const tags = [];
    for (const { props } of parseMultistatus(xml)) {
        if (props.id === undefined || props.id === null || props.id === '') continue;
        tags.push({
            id: parseInt(props.id, 10),
            name: props['display-name'] || null,
            userVisible: isTrue(props['user-visible']),
            userAssignable: isTrue(props['user-assignable']),
        });
    }
    return { count: tags.length, tags };
}

/** @type {TagHandler} */
async function createTag(args, { baseUrl, ncFetch, authError }) {
    if (!args.name) return { error: 'name is required' };
    const res = await ncFetch(`${baseUrl}/remote.php/dav/systemtags/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: args.name,
            userVisible: args.userVisible !== false,
            userAssignable: args.userAssignable !== false,
            canAssign: args.userAssignable !== false,
        }),
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 403) return { error: 'Tag creation requires admin privileges on this Nextcloud server.' };
    if (res.status === 409) return { error: `Tag already exists: ${args.name}` };
    if (!res.ok && res.status !== 201) {
        const text = await res.text().catch(() => '');
        return { error: `Tag create failed (${res.status}): ${text.slice(0, 200)}` };
    }
    // Tag id comes back in the Content-Location header.
    const loc = res.headers.get('content-location') || '';
    const id = parseInt((loc.match(/\/(\d+)\/?$/) || [])[1] || '0', 10) || null;
    return { success: true, id, name: args.name };
}

/** @param {string} baseUrl @param {string | number} fileId @param {string | number} tagId */
const relationUrl = (baseUrl, fileId, tagId) => `${baseUrl}/remote.php/dav/systemtags-relations/files/${encodeURIComponent(fileId)}/${encodeURIComponent(tagId)}`;

/** @type {TagHandler} */
async function tagFile(args, { baseUrl, ncFetch, authError }) {
    if (!args.fileId || !args.tagId) return { error: 'fileId and tagId are required' };
    const res = await ncFetch(relationUrl(baseUrl, args.fileId, args.tagId), {
        method: 'PUT',
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: 'File or tag not found.' };
    if (res.status === 409) return { error: 'File already has this tag.' };
    if (res.status === 412) {
        return { error: `Tag ${args.tagId} does not exist or this account may not assign it. Use nextcloud_list_tags for valid tag ids.` };
    }
    if (!res.ok && res.status !== 201 && res.status !== 204) {
        return { error: `Tag attach failed (${res.status})` };
    }
    return { success: true, fileId: args.fileId, tagId: args.tagId };
}

/** @type {TagHandler} */
async function untagFile(args, { baseUrl, ncFetch, authError }) {
    if (!args.fileId || !args.tagId) return { error: 'fileId and tagId are required' };
    const res = await ncFetch(relationUrl(baseUrl, args.fileId, args.tagId), {
        method: 'DELETE',
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: 'File or tag relation not found.' };
    if (!res.ok && res.status !== 204) return { error: `Untag failed (${res.status})` };
    return { success: true, fileId: args.fileId, tagId: args.tagId };
}

/** @type {TagHandler} */
async function findFilesByTag(args, { baseUrl, ncFetch, authError, uid, root }) {
    if (!args.tagId) return { error: 'tagId is required' };
    const limit = Math.min(Math.max(args.limit || 100, 1), 500);
    const body = `<?xml version="1.0" encoding="utf-8" ?>
<oc:filter-files xmlns:oc="http://owncloud.org/ns" xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <oc:fileid/>
  </d:prop>
  <oc:filter-rules>
    <oc:systemtag>${args.tagId}</oc:systemtag>
  </oc:filter-rules>
</oc:filter-files>`;
    const res = await ncFetch(`${root}/`, {
        method: 'REPORT',
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        body,
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Tag search failed (${res.status})` };
    const xml = await res.text();
    const items = parsePropfind(xml, baseUrl, uid).slice(0, limit);
    return { tagId: args.tagId, count: items.length, items };
}

/** @type {Record<string, TagHandler>} */
const HANDLERS = {
    nextcloud_list_tags: listTags,
    nextcloud_create_tag: createTag,
    nextcloud_tag_file: tagFile,
    nextcloud_untag_file: untagFile,
    nextcloud_find_files_by_tag: findFilesByTag,
};

// Returns undefined when the tool belongs to another Nextcloud file family, so
// the facade can hand it to the next handler.
/**
 * @param {string} toolName
 * @param {TagArgs} args
 * @param {import('./webdav').FilesToolCtx} ctx
 */
async function executeTagTool(toolName, args, ctx) {
    const handler = Object.hasOwn(HANDLERS, toolName) ? HANDLERS[toolName] : null;
    return handler ? handler(args, ctx) : undefined;
}

module.exports = { executeTagTool };
