/**
 * The hand-over from the home composer to `/chat/new`: the draft is sent
 * there on mount, so whatever the composer held that is not a stored
 * preference (attached bases, the brain switch) has to travel in the route.
 *
 * The composer's files cannot: a route carries text, and a photo is a local
 * file. They are staged here instead, in memory, and taken ONCE by the new
 * chat that mounts next (takeNewChatFiles), which sends them with the draft.
 * Taking clears them, so a re-render, a Back and a later New chat cannot send
 * them again. Kept apart from Android's share hand-off (features/search
 * shareIntent), whose files wait in the composer instead of being sent.
 */

import type { Attachment } from './types';

let staged: Attachment[] = [];

/** Where the home composer's send goes: the draft, plus what the composer held. */
export function newChatHref(draft: string, knowledgeBaseIds: readonly string[], memoryEnabled: boolean): string {
    const params: string[] = [];
    // A files-only send has no words: the files wait in stageNewChatFiles.
    if (draft) params.push(`draft=${encodeURIComponent(draft)}`);
    if (knowledgeBaseIds.length) params.push(`kb=${encodeURIComponent(knowledgeBaseIds.join(','))}`);
    if (!memoryEnabled) params.push('memory=off');
    return params.length ? `/chat/new?${params.join('&')}` : '/chat/new';
}

/** The files the home composer sent, for the new chat about to open. Replaces anything staged before. */
export function stageNewChatFiles(files: readonly Attachment[]): void {
    staged = [...files];
}

/** The staged files, once: the next caller gets none. */
export function takeNewChatFiles(): Attachment[] {
    const files = staged;
    staged = [];
    return files;
}
