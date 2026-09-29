/**
 * File comments over the DAV comments endpoint — read the thread on a file id
 * and post a new comment.
 */

const { parseMultistatus } = require('./webdav');

// Returns undefined when the tool belongs to another Nextcloud file family, so
// the facade can hand it to the next handler.
async function executeCommentTool(toolName, args, ctx) {
    const { baseUrl, ncFetch, authError } = ctx;

    switch (toolName) {
        case 'nextcloud_list_file_comments': {
            if (!args.fileId) return { error: 'fileId is required' };
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);
            const body = `<?xml version="1.0" encoding="utf-8" ?>
<oc:filter-comments xmlns:oc="http://owncloud.org/ns" xmlns:d="DAV:">
  <oc:limit>${limit}</oc:limit>
  <oc:offset>0</oc:offset>
</oc:filter-comments>`;
            const res = await ncFetch(`${baseUrl}/remote.php/dav/comments/files/${encodeURIComponent(args.fileId)}/`, {
                method: 'REPORT',
                headers: { 'Content-Type': 'application/xml; charset=utf-8' },
                body,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `File not found or no comments support: ${args.fileId}` };
            if (!res.ok) return { error: `Comments fetch failed (${res.status})` };
            const xml = await res.text();
            const comments = [];
            for (const { href, props } of parseMultistatus(xml)) {
                const idMatch = (href || '').match(/\/(\d+)\/?$/);
                if (!idMatch) continue;
                comments.push({
                    id: parseInt(idMatch[1], 10),
                    message: props.message || '',
                    actor: props.actorDisplayName || null,
                    actorId: props.actorId || null,
                    created: props.creationDateTime || null,
                });
            }
            return { fileId: args.fileId, count: comments.length, comments };
        }

        case 'nextcloud_add_file_comment': {
            if (!args.fileId || !args.message) return { error: 'fileId and message are required' };
            const res = await ncFetch(`${baseUrl}/remote.php/dav/comments/files/${encodeURIComponent(args.fileId)}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actorType: 'users', verb: 'comment', message: args.message }),
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `File not found: ${args.fileId}` };
            if (!res.ok && res.status !== 201) {
                const text = await res.text().catch(() => '');
                return { error: `Comment failed (${res.status}): ${text.slice(0, 200)}` };
            }
            return { success: true, fileId: args.fileId };
        }

        default:
            return undefined;
    }
}

module.exports = { executeCommentTool };
