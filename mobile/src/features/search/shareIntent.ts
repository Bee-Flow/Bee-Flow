/**
 * The hand-off between Android's share sheet and a new chat.
 *
 * When someone shares a page, a note or a PDF into Bee Flow, the OS launches
 * (or resumes) the app with an ACTION_SEND intent. expo-share-intent surfaces
 * that as a one-shot value — read it late and it is gone, read it twice and
 * you get it twice — so it is drained EXACTLY once, here, into this module,
 * and the chat screen picks it up on its own schedule.
 *
 * A module-level box rather than a route parameter, for two reasons:
 *
 *   1. A shared document can be megabytes of text. Route params are serialised
 *      into the navigation state and survive in the back stack; a 2 MB string
 *      in there is a memory leak with a URL attached.
 *   2. Shared content is by definition the user's private data. Keeping it out
 *      of navigation state keeps it out of anything that logs or persists that
 *      state.
 *
 * Nothing here touches the network. The payload is handed to the composer,
 * which sends it the way any other message is sent — through the user's own
 * server, with the same DLP and encryption path.
 */

import { create } from 'zustand';

export interface SharedFile {
    name: string;
    mimeType: string;
    /** A `file://` or `content://` uri the composer can read and upload. */
    uri: string;
    size: number | null;
}

export interface SharedPayload {
    /** Plain text, a note, or the text half of a "share link with title". */
    text: string | null;
    /** A shared URL, when Android classified the intent as a web link. */
    webUrl: string | null;
    files: SharedFile[];
    /** Epoch ms — lets a consumer ignore a payload that is absurdly stale. */
    receivedAt: number;
}

interface ShareState {
    pending: SharedPayload | null;
    /** Replaces any undelivered payload: the newest share is the one meant. */
    put: (payload: SharedPayload) => void;
    clear: () => void;
}

const useShareStore = create<ShareState>()((set) => ({
    pending: null,
    put: (payload) => set({ pending: payload }),
    clear: () => set({ pending: null }),
}));

/** Reactive read, for a screen that wants to render the pending payload. */
export function usePendingShare(): SharedPayload | null {
    return useShareStore((state) => state.pending);
}

/**
 * Take the payload and clear it in one step.
 *
 * Consuming rather than reading is the contract: a chat screen that remounts
 * (rotation, a back-then-forward, Android killing the activity) must not
 * silently re-attach a document the user already sent.
 */
export function consumePendingShare(): SharedPayload | null {
    const { pending, clear } = useShareStore.getState();
    if (pending) clear();
    return pending;
}

/** Used by the gate. Exported so a screen can stage a payload in a test. */
export function stagePendingShare(payload: SharedPayload): void {
    useShareStore.getState().put(payload);
}

export function hasPendingShare(): boolean {
    return useShareStore.getState().pending !== null;
}

/**
 * Fold a payload into something the composer can prefill with.
 *
 * A URL-only share becomes the message text, because "summarise this page" is
 * the thing people do with a shared link and an empty composer next to an
 * invisible attachment reads as a bug.
 */
export function describeSharedPayload(payload: SharedPayload): {
    text: string;
    files: SharedFile[];
} {
    const parts: string[] = [];
    if (payload.text?.trim()) parts.push(payload.text.trim());
    // Android often sends the URL inside `text` as well; only add it when it
    // is genuinely absent, or the message reads twice.
    if (payload.webUrl && !parts.some((part) => part.includes(payload.webUrl as string))) {
        parts.push(payload.webUrl);
    }
    return { text: parts.join('\n\n'), files: payload.files };
}
