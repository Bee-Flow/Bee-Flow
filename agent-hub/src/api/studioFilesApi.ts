// Stored files of an App Studio app (/api/studio-apps/:id/data/attachments).
// Answers with the raw Response, like authFetch: the caller reads `ok` and the body.
import { API_BASE, authFetch } from './mutate';

const attachmentsUrl = (appId: string) => `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/attachments`;

export const studioFilesApi = {
    /** Redeem a pending mailbox attachment into a stored file. */
    materialize: (appId: string, attachmentId: string | undefined, inline?: boolean) => authFetch(`${attachmentsUrl(appId)}/materialize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The provider's id is all the server needs: it finds the row itself,
        // under this viewer's own read access.
        // `inline` asks for an inline image (a cid: picture in a mail body);
        // without it the server refuses inline attachments, as before.
        body: JSON.stringify(inline ? { attachmentId, inline: true } : { attachmentId }),
    }),
    /** Fetch the bytes behind a stored file or a legacy URL. */
    fetchHref: (href: string) => authFetch(href),
};
