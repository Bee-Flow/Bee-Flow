/**
 * One Outlook attachment by the ids the sync stored, with a second look when
 * those ids have gone stale.
 *
 * Graph's default message ids change when a message moves to another folder
 * (Microsoft Learn, "Obtain immutable identifiers for Outlook resources"). A
 * desk that files its mail away after the sync saw it therefore gets 404
 * ErrorItemNotFound on every attachment it opens later, while the mail itself
 * is right there in Outlook. The conversation id does not change with a move,
 * so on a 404 this reads the conversation across all folders and takes the
 * attachment with the same name and size: the same identity the sync uses to
 * drop a file seen twice in one conversation (mailboxThreadsAndFiles.js).
 */

/** What the sync knew about the attachment, to find it again after a move. */
export type Relocate = { threadKey?: string | null; name?: string | null; size?: number | null } | null | undefined;

type GraphGet = (path: string) => Promise<Record<string, unknown>>;
type GraphAttachment = Record<string, unknown> & {
    id?: string; name?: string; size?: number; isInline?: boolean; contentType?: string; contentBytes?: string; '@odata.type'?: string;
};

const THREAD_PREFIX = 'outlook:';
// Messages read from one conversation; past this a long thread is read in part.
const MAX_THREAD_MESSAGES = 50;

/** The Graph conversation id inside an Outlook thread key, or null for any other key. */
export function conversationIdOf(threadKey: string | null | undefined): string | null {
    const key = String(threadKey || '');
    return key.startsWith(THREAD_PREFIX) && key.length > THREAD_PREFIX.length ? key.slice(THREAD_PREFIX.length) : null;
}

const attachmentPath = (base: string, messageId: string, attachmentId: string) =>
    `${base}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;

/** The attachment as it is now, found through its conversation; null when it is not there. */
async function relocate(graph: GraphGet, base: string, hint: NonNullable<Relocate>): Promise<GraphAttachment | null> {
    const conversationId = conversationIdOf(hint.threadKey);
    if (!conversationId || !hint.name) return null;
    // %20 rather than '+': OData reads a '+' in the query literally.
    const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`);
    const list = await graph(`${base}/messages?$filter=${filter}&$select=id,hasAttachments&$top=${MAX_THREAD_MESSAGES}`);
    const messages = (Array.isArray(list.value) ? list.value : []) as Array<{ id?: string; hasAttachments?: boolean }>;
    for (const message of messages) {
        if (!message.id || !message.hasAttachments) continue;
        const atts = await graph(`${base}/messages/${encodeURIComponent(message.id)}/attachments?$select=id,name,size,isInline`);
        const found = ((Array.isArray(atts.value) ? atts.value : []) as GraphAttachment[]).find((a) => !a.isInline
            && a.name === hint.name && (!hint.size || Number(a.size) === Number(hint.size)));
        if (found?.id) return graph(attachmentPath(base, message.id, found.id)) as Promise<GraphAttachment>;
    }
    return null;
}

/**
 * The attachment resource (no $select: Graph refuses contentBytes on the base
 * `attachment` type). A 404 with a usable hint tries the conversation once;
 * when that finds nothing the original 404 stands.
 */
export async function fetchOutlookAttachment(graph: GraphGet, { base, messageId, attachmentId, hint }: {
    base: string; messageId: string; attachmentId: string; hint?: Relocate;
}): Promise<GraphAttachment> {
    try {
        return await graph(attachmentPath(base, messageId, attachmentId)) as GraphAttachment;
    } catch (err) {
        if ((err as { status?: number })?.status !== 404 || !hint) throw err;
        const moved = await relocate(graph, base, hint);
        if (!moved) throw err;
        return moved;
    }
}
