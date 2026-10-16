import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../lib/transcriptionsApi';

/** One row of `GET /api/transcriptions/tags`, as the server may send it. */
interface RawTagCount {
    tag: string;
    count: number | string;
}

/** A tag with the number of notes carrying it. */
interface TagCount {
    tag: string;
    count: number;
}

/**
 * The library's tag vocabulary with counts (Meeting Notes artboard 1a:
 * "dataweging 4 · spelersmonitor 3 · +9 tags").
 *
 * Source of truth is `GET /api/transcriptions/tags`, which counts over EVERY
 * note the caller may read; the loaded list is a page of 50, so a vocabulary
 * derived from it used to miss any tag past the first page. The rows on
 * screen are still the fallback: until the server answers — or when it
 * cannot — the chips are derived from `meetings`, so the filter never goes
 * blank because a count did not arrive.
 *
 * `refreshKey` re-asks the server: the page bumps it when a tag is added or
 * removed on a note, so a new tag becomes a chip without a reload.
 *
 * Returns `{ tags: [{ tag, count }], fromServer, refetch }`.
 */
export default function useMeetingTags(meetings: Array<{ tags?: unknown }> | null | undefined, refreshKey: number = 0) {
    const [server, setServer] = useState<TagCount[] | null>(null); // null → not (yet) answered

    const load = useCallback(async () => {
        try {
            const list = await api.listTranscriptionTags();
            return list
                .filter((r: RawTagCount) => r && typeof r.tag === 'string' && r.tag)
                .map((r: RawTagCount) => ({ tag: r.tag, count: Number(r.count) || 0 }));
        } catch (_) {
            return null;
        }
    }, []);

    useEffect(() => {
        let alive = true;
        load().then((list: TagCount[] | null) => { if (alive) setServer(list); });
        return () => { alive = false; };
    }, [load, refreshKey]);

    const fromRows = useMemo(() => {
        const counts = new Map<string, number>();
        (meetings || []).forEach((m) => (Array.isArray(m.tags) ? m.tags : []).forEach((t: unknown) => {
            if (typeof t !== 'string' || !t) return;
            counts.set(t, (counts.get(t) || 0) + 1);
        }));
        return Array.from(counts, ([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }, [meetings]);

    const refetch = useCallback(() => { load().then(setServer); }, [load]);

    return {
        tags: server || fromRows,
        fromServer: server !== null,
        refetch,
    };
}
