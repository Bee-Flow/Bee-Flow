/**
 * File version history — list the previous versions of a file id and restore
 * one of them.
 */

const { parseMultistatus } = require('./webdav');

// Returns undefined when the tool belongs to another Nextcloud file family, so
// the facade can hand it to the next handler.
async function executeVersionTool(toolName, args, ctx) {
    const { baseUrl, ncFetch, authError, uid } = ctx;

    switch (toolName) {
        case 'nextcloud_list_versions': {
            if (!args.fileId) return { error: 'fileId is required' };
            const url = `${baseUrl}/remote.php/dav/versions/${encodeURIComponent(uid)}/versions/${encodeURIComponent(args.fileId)}/`;
            const body = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`;
            const res = await ncFetch(url, {
                method: 'PROPFIND',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `No version history for fileId ${args.fileId}` };
            if (!res.ok) return { error: `Version list failed (${res.status})` };
            const xml = await res.text();
            const versions = [];
            for (const { href, props } of parseMultistatus(xml)) {
                if (!href) continue;
                // The first response is the version container itself — skip.
                const decodedHref = decodeURIComponent(href);
                const segments = decodedHref.split('/').filter(Boolean);
                const versionId = segments[segments.length - 1];
                if (versionId === String(args.fileId)) continue;
                versions.push({
                    versionId,
                    size: parseInt(props.getcontentlength || '0', 10),
                    modified: props.getlastmodified || null,
                    contentType: props.getcontenttype || null,
                    href: decodedHref,
                });
            }
            return { fileId: args.fileId, count: versions.length, versions };
        }

        case 'nextcloud_restore_version': {
            if (!args.fileId || !args.versionId) return { error: 'fileId and versionId are required' };
            const sourceUrl = `${baseUrl}/remote.php/dav/versions/${encodeURIComponent(uid)}/versions/${encodeURIComponent(args.fileId)}/${encodeURIComponent(args.versionId)}`;
            const destUrl = `${baseUrl}/remote.php/dav/versions/${encodeURIComponent(uid)}/restore/target`;
            const res = await ncFetch(sourceUrl, {
                method: 'MOVE',
                headers: { 'Destination': destUrl },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Version not found: ${args.versionId}` };
            if (!res.ok && res.status !== 204) {
                const text = await res.text().catch(() => '');
                return { error: `Version restore failed (${res.status}): ${text.slice(0, 200)}` };
            }
            return { success: true, fileId: args.fileId, versionId: args.versionId };
        }

        default:
            return undefined;
    }
}

module.exports = { executeVersionTool };
