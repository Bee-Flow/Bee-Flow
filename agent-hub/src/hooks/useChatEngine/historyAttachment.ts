/** An attachment as the composer and the message list carry it. */
export interface ChatAttachment {
    name: string;
    type: string;
    storageKey?: string;
    url?: string;
    extractionKey?: string;
    extractedText?: string;
    [key: string]: unknown;
}

/** The same attachment, stripped to what history may carry. */
export interface HistoryAttachment {
    name: string;
    type: string;
    storageKey?: string;
    url?: string;
    extractionKey?: string;
    extractedText?: string;
}

// Attachment shape for history sent to the server. Keeps the sidecar fields
// the server-side historyHydrator needs to re-inject file content on later
// turns (extractedText / extractionKey / storageKey / url) — without them the
// model only sees a "[File previously attached]" placeholder. Deliberately
// excludes `content`: raw base64 can be megabytes, while extractedText is
// capped server-side (≤8k chars inline). Only DB-loaded messages carry these
// fields; live in-session uploads don't have them client-side, and the server
// re-merges sidecars from the DB whenever a conversation id exists.
export const toHistoryAttachment = (a: ChatAttachment): HistoryAttachment => ({
    name: a.name,
    type: a.type,
    ...(a.storageKey ? { storageKey: a.storageKey } : {}),
    ...(a.url ? { url: a.url } : {}),
    ...(a.extractionKey ? { extractionKey: a.extractionKey } : {}),
    ...(typeof a.extractedText === 'string' && a.extractedText ? { extractedText: a.extractedText } : {}),
});
