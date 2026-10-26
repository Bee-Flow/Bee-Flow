// The reads behind the Support inbox: the thread list for a filter, one open
// thread with its messages, its activity log, the mailbox that feeds the inbox
// and the canned responses. Each used to be a loader function an effect called;
// a non-ok answer is "no answer" (the screen keeps what it shows), so the
// readers throw on it and the cache keeps the last good data.

import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { supportInboxApi } from '../supportInboxApi';

export const supportInboxKeys = {
    all: ['support-inbox'] as const,
    threads: (query: string) => ['support-inbox', 'threads', query] as const,
    thread: (id: string) => ['support-inbox', 'thread', id] as const,
    events: (id: string) => ['support-inbox', 'events', id] as const,
    mailbox: () => ['support-inbox', 'mailbox'] as const,
    canned: () => ['support-inbox', 'canned'] as const,
};

async function jsonOf(res: Response, what: string): Promise<unknown> {
    if (!res.ok) throw new Error(`${what} ${res.status}`);
    return res.json();
}

export interface ThreadListAnswer<Thread> { threads: Thread[]; counts: Record<string, number> }

/** The inbox's threads and status counters for one filter (`query` is the URL query string). */
export function useSupportThreadsQuery<Thread>(query: string) {
    return useQuery({
        queryKey: supportInboxKeys.threads(query),
        queryFn: async (): Promise<ThreadListAnswer<Thread>> => {
            const data = await jsonOf(await supportInboxApi.threads(query), 'threads') as Partial<ThreadListAnswer<Thread>>;
            return { threads: data.threads || [], counts: data.counts || {} };
        },
        placeholderData: keepPreviousData,
        staleTime: 0,
        retry: false,
    });
}

interface ThreadAnswer<Thread, Message> { thread: Thread; messages: Message[] }

/** Options of one open thread, for the query and for a re-read after a change. */
function supportThreadOptions<Thread, Message>(id: string) {
    return queryOptions({
        queryKey: supportInboxKeys.thread(id),
        queryFn: async (): Promise<ThreadAnswer<Thread, Message>> => {
            const data = await jsonOf(await supportInboxApi.thread(id), 'thread') as { thread: Thread; messages?: Message[] };
            return { thread: data.thread, messages: data.messages || [] };
        },
        staleTime: 0,
        retry: false,
    });
}

/** The open thread with its messages. */
export function useSupportThreadQuery<Thread, Message>(id: string | null) {
    return useQuery({ ...supportThreadOptions<Thread, Message>(id ?? ''), enabled: !!id });
}

/** The activity log of the open thread, read once the panel is shown. */
export function useSupportEventsQuery<Event>(id: string | null, enabled: boolean) {
    return useQuery({
        queryKey: supportInboxKeys.events(id ?? ''),
        enabled: enabled && !!id,
        queryFn: async (): Promise<Event[]> => {
            const data = await jsonOf(await supportInboxApi.events(id as string), 'events') as { events?: unknown };
            return Array.isArray(data?.events) ? data.events as Event[] : [];
        },
        staleTime: 0,
        retry: false,
    });
}

/** The mailbox feeding the inbox (null when none is connected). */
export function useSupportMailboxQuery<Mailbox>() {
    return useQuery({
        queryKey: supportInboxKeys.mailbox(),
        queryFn: async (): Promise<Mailbox | null> => {
            const data = await jsonOf(await supportInboxApi.mailbox(), 'mailbox') as { mailbox?: Mailbox | null };
            return data.mailbox || null;
        },
        staleTime: 0,
        retry: false,
    });
}

/** The canned responses the reply composer offers. */
export function useSupportCannedQuery<Canned>() {
    return useQuery({
        queryKey: supportInboxKeys.canned(),
        queryFn: async (): Promise<Canned[]> => {
            const data = await jsonOf(await supportInboxApi.canned(), 'canned') as { responses?: Canned[] };
            return data.responses || [];
        },
        retry: false,
    });
}
