/**
 * Where a person lands after deleting the conversation they are looking at.
 *
 * The details screen is pushed over its chat, which is pushed over wherever
 * the chat was opened from: the drawer's list, the conversation list, a
 * project, search, a notification. Both of the top two show a conversation
 * that no longer exists, so both go — and ONLY those two: the person comes
 * back to the list they came from, as the web sidebar does. Unwinding the
 * whole stack and replacing the drawer landed them on a new chat's composer
 * with the drawer rebuilt under them.
 *
 * Nothing underneath (a notification opened on a cold start pushes the chat
 * with no drawer below it) is the one case that falls back to the Chat tab.
 * That is a `replace` of the last deleted screen, not openRoute: openRoute's
 * dismissTo, finding no drawer to return to, pops one screen and pushes the
 * drawer on the rest — leaving the deleted chat under the drawer, one Back
 * away. There is no drawer here to stack a second copy of.
 */

import type { Href } from 'expo-router';

/** The route names expo-router gives app/chat/[id].tsx and app/chat/[id]/details.tsx. */
export const CHAT_ROUTE = 'chat/[id]';
export const DETAILS_ROUTE = 'chat/[id]/details';

/** One entry of the root Stack, as `navigation.getState().routes` lists it. */
export interface StackEntry {
    name: string;
    params?: object;
}

function idOf(entry: StackEntry | undefined): unknown {
    return (entry?.params as { id?: unknown } | undefined)?.id;
}

/**
 * Does this entry show the conversation? A chat opened as `/chat/new` keeps
 * `new` in its address after the server names it, so a `new` chat counts
 * when the details screen of this conversation sits right on top of it —
 * details is only ever opened from its own chat.
 */
function shows(entry: StackEntry, above: StackEntry | undefined, conversationId: string): boolean {
    if (entry.name !== CHAT_ROUTE && entry.name !== DETAILS_ROUTE) return false;
    const id = idOf(entry);
    if (id === conversationId) return true;
    return entry.name === CHAT_ROUTE && id === 'new' && above?.name === DETAILS_ROUTE && idOf(above) === conversationId;
}

/** How many screens, counted down from the top of the stack, show the conversation. */
export function deletedChatDepth(routes: readonly StackEntry[], conversationId: string): number {
    let depth = 0;
    for (let i = routes.length - 1; i >= 0; i--) {
        const entry = routes[i] as StackEntry;
        if (!shows(entry, routes[i + 1], conversationId)) break;
        depth += 1;
    }
    return depth;
}

/** The part of expo-router's router this needs (useRouter() satisfies it). */
export interface LeaveRouter {
    dismiss: (count?: number) => void;
    replace: (href: Href) => void;
}

const deleted = new Set<string>();

/**
 * Conversations deleted this session. The chat screen's leave guard reads it
 * when a removal comes, not when it last rendered: the details screen deletes
 * and pops the chat under it in one callback, before anything renders again.
 */
export function markDeleted(conversationId: string): void {
    deleted.add(conversationId);
}

export function wasDeleted(conversationId: string | null): boolean {
    return conversationId !== null && deleted.has(conversationId);
}

/**
 * Pop the screens that showed the deleted conversation — at least the one
 * doing the deleting — and land on what is under them, else on the Chat tab.
 */
export function leaveDeletedChat(router: LeaveRouter, routes: readonly StackEntry[], conversationId: string): void {
    const depth = Math.max(1, deletedChatDepth(routes, conversationId));
    if (routes.length > depth) {
        router.dismiss(depth);
        return;
    }
    if (depth > 1) router.dismiss(depth - 1);
    router.replace('/');
}
