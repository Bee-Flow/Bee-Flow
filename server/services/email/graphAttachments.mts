/**
 * Outgoing attachments for Microsoft Graph: MailComposer attachments
 * (`{ filename, content: Buffer, contentType }`) as Graph fileAttachments.
 *
 * Graph takes attachments inline only while the whole request stays under
 * 4 MB; base64 makes that about 3 MB of files. Larger needs an upload session
 * on a draft (and Mail.ReadWrite), which the send path does not have, so it is
 * refused rather than dropped: a reply that silently leaves out the drawing it
 * talks about is worse than one that does not send.
 */

export const GRAPH_INLINE_ATTACHMENT_BYTES = 3 * 1024 * 1024;

export type MailAttachment = { filename?: string | false; content?: unknown; contentType?: string };

export type GraphFileAttachment = {
    '@odata.type': '#microsoft.graph.fileAttachment';
    name: string;
    contentType: string;
    contentBytes: string;
};

function tooLarge(): Error & { status: number } {
    return Object.assign(new Error('Attachments over 3 MB in total cannot be sent through Outlook.'), { status: 413 });
}

export function graphAttachments(attachments: MailAttachment[] | null | undefined): GraphFileAttachment[] {
    if (!attachments || !attachments.length) return [];
    let total = 0;
    return attachments.map((a) => {
        if (!Buffer.isBuffer(a.content)) throw new Error('An Outlook attachment needs its bytes, not a path.');
        total += a.content.length;
        if (total > GRAPH_INLINE_ATTACHMENT_BYTES) throw tooLarge();
        return {
            '@odata.type': '#microsoft.graph.fileAttachment',
            // Same hygiene as a header value: the name ends up in a MIME header.
            name: String(a.filename || '').replace(/[\r\n]+/g, ' ').trim() || 'bijlage',
            contentType: a.contentType || 'application/octet-stream',
            contentBytes: a.content.toString('base64'),
        };
    });
}
