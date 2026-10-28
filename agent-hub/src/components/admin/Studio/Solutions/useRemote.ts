import { readJson, useRemoteAnswer } from '@/api/queries/studioRemote';

export type RemoteStatus = 'idle' | 'loading' | 'ok' | 'error';

/** `T` is the body shape the route promises; callers that read the body name it. */
export interface RemoteState<T = unknown> {
    status: RemoteStatus;
    data: T | null;
}

/**
 * One remote list, with the difference between "none" and "could not read"
 * kept.
 *
 * Every Solutions screen loads lists that can genuinely be empty — the tables
 * an installer may pick, the people to share with, the Blueprints kept on this
 * instance, the Solutions themselves. Each of those, read with a plain
 * `useState([])` and a silent catch, renders a failure exactly like an empty
 * answer, and a silent empty list teaches somebody their organisation has none.
 * So the status is part of the answer here rather than something each caller
 * remembers to keep.
 *
 * `enabled` defers the fetch until the screen that needs it is open — the
 * install wizard asks four different services and most installs never reach its
 * third step.
 *
 * Statuses: `idle` (not asked), `loading` (asked, no answer yet), `ok`
 * (`data` is the parsed body), `error` (asked and it did not work — `data`
 * stays null so a caller cannot accidentally render a half-answer).
 */
export { readJson };

export default function useRemote<T = unknown>(url: string | null | undefined, enabled?: boolean): RemoteState<T> {
    const query = useRemoteAnswer<T>(url, enabled);
    // The answer belongs to a URL (it is in the query key); while a read is in
    // flight, or none has answered yet, the state is `loading` with no data.
    if (!enabled || !url) return { status: 'idle', data: null };
    if (query.isFetching || !query.data) return { status: 'loading', data: null };
    return query.data.ok ? { status: 'ok', data: query.data.body } : { status: 'error', data: null };
}
