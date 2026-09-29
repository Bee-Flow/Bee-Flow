/**
 * System tags — list and create tags, attach or detach them from a file, and
 * find every file carrying one.
 */

const { parseMultistatus, parsePropfind } = require('./webdav');

// Returns undefined when the tool belongs to another Nextcloud file family, so
// the facade can hand it to the next handler.
async function executeTagTool(toolName, args, ctx) {
    const { baseUrl, ncFetch, authError, uid, root } = ctx;

    switch (toolName) {
        case 'nextcloud_list_tags': {
            const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <oc:id/>
    <oc:display-name/>
    <oc:user-visible/>
    <oc:user-assignable/>
    <oc:can-assign/>
  </d:prop>
</d:propfind>`;
            const res = await ncFetch(`${baseUrl}/remote.php/dav/systemtags/`, {
                method: 'PROPFIND',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body,
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Tags list failed (${res.status})` };
            const xml = await res.text();
            const tags = [];
            const isTrue = (v) => v === 'true' || v === '1' || v === true || v === 1;
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

        case 'nextcloud_create_tag': {
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

        case 'nextcloud_tag_file': {
            if (!args.fileId || !args.tagId) return { error: 'fileId and tagId are required' };
            const res = await ncFetch(`${baseUrl}/remote.php/dav/systemtags-relations/files/${encodeURIComponent(args.fileId)}/${encodeURIComponent(args.tagId)}`, {
                method: 'PUT',
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'File or tag not found.' };
            if (res.status === 409) return { error: 'File already has this tag.' };
            if (!res.ok && res.status !== 201 && res.status !== 204) {
                return { error: `Tag attach failed (${res.status})` };
            }
            return { success: true, fileId: args.fileId, tagId: args.tagId };
        }

        case 'nextcloud_untag_file': {
            if (!args.fileId || !args.tagId) return { error: 'fileId and tagId are required' };
            const res = await ncFetch(`${baseUrl}/remote.php/dav/systemtags-relations/files/${encodeURIComponent(args.fileId)}/${encodeURIComponent(args.tagId)}`, {
                method: 'DELETE',
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: 'File or tag relation not found.' };
            if (!res.ok && res.status !== 204) return { error: `Untag failed (${res.status})` };
            return { success: true, fileId: args.fileId, tagId: args.tagId };
        }

        case 'nextcloud_find_files_by_tag': {
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

        default:
            return undefined;
    }
}

module.exports = { executeTagTool };
