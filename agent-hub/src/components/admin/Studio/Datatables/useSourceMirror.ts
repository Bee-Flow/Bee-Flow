import { useCallback, useEffect, useRef, useState } from 'react';
import { isSourceMirror } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import type { Json, MirrorSource, SyncInfo, TableLike } from './datatableTypes';

/** An answer that carries a mirror's blocks, bare or under `datatable`. */
interface MirrorBody {
    datatable?: MirrorBody | null;
    source?: MirrorSource | null;
    sync?: SyncInfo | null;
    dataVersion: number;
}

interface MirrorState {
    source?: MirrorSource | null;
    sync?: SyncInfo | null;
}

/** The route family one kind of mirror uses. */
interface MirrorApi {
    pulse: (id: string) => Promise<MirrorBody | null>;
    refresh: (id: string) => Promise<MirrorBody | null>;
    update: (id: string, patch: Json) => Promise<MirrorBody | null>;
    setRelations: (id: string, relations: Json[]) => Promise<MirrorBody | null>;
    relink: (id: string, body: Json | null) => Promise<MirrorBody | null>;
}

/**
 * A mirror's `source` and `sync` blocks — and the PULSE that keeps it live.
 *
 * A mirror is a Nextcloud table, or one sheet of a spreadsheet file, seen
 * from Bee Flow, and a person looking at it expects what the source has now.
 * So while the table is WATCHED (the rows or the source tab open — the
 * detail view says which) this hook pulses the server every PULSE_MS. Each
 * pulse makes the server re-check the source (it does so at most once per
 * few seconds, however many people pulse — and for a file that check is one
 * metadata call, never a download) and answers the row version. The version
 * only moves when rows actually changed, so `dataVersion` is what the row
 * browser reloads on — no flicker on the pulses that found nothing new.
 *
 * Nothing polls when nobody is looking: the ticker and the source's push
 * events keep the copy fresh in the background.
 *
 * ── ONE HOOK, TWO ROUTE FAMILIES ──────────────────────────────────────
 * The Nextcloud kind keeps its `/:id/nextcloud/*` routes for a release and
 * the spreadsheet kind lives on the kind-agnostic `/:id/source/*`; which set
 * a table uses is decided per call, by kind, and looked up LAZILY on
 * `datatablesApi` (never destructured at module load) so a test that swaps
 * one method sees its swap. Returns null for a table that is not a mirror,
 * without a request.
 */
const PULSE_MS = 5000;

const API: Record<string, MirrorApi> = {
    nextcloud_table: {
        pulse: (id: string) => datatablesApi.pulseNc(id),
        refresh: (id: string) => datatablesApi.refreshNc(id),
        update: (id: string, patch: Json) => datatablesApi.updateNc(id, patch),
        setRelations: (id: string, relations: Json[]) => datatablesApi.setNcRelations(id, relations),
        relink: (id: string, body: Json | null) => (datatablesApi.relinkNc as (id: string, body: Json | null) => Promise<MirrorBody | null>)(id, body),
    },
    spreadsheet_file: {
        pulse: (id: string) => datatablesApi.pulseSource(id),
        refresh: (id: string) => datatablesApi.refreshSource(id),
        update: (id: string, patch: Json) => datatablesApi.updateSource(id, patch),
        setRelations: (id: string, relations: Json[]) => datatablesApi.setSourceRelations(id, relations),
        relink: (id: string, body: Json | null) => datatablesApi.relinkSource(id, body),
    },
};

/** A table the hook watches: it has an id to pulse. */
interface MirrorTable extends TableLike {
    id: string;
}

export default function useSourceMirror(table: MirrorTable) {
    const mirror = isSourceMirror(table);
    const api = (API[table?.managedKind as string] || null) as MirrorApi;
    const [state, setState] = useState<MirrorState | null>(() => (mirror ? { source: table.source || null, sync: table.sync || null } : null));
    const [dataVersion, setDataVersion] = useState<number | null>(null);
    const [loading, setLoading] = useState(mirror);
    const [error, setError] = useState<string | null>(null);
    const [watching, setWatching] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const apply = useCallback((body?: MirrorBody | null) => {
        const dt = body && body.datatable ? body.datatable : body;
        if (!dt) return;
        setState({ source: dt.source || null, sync: dt.sync || null });
    }, []);

    const reload = useCallback(async () => {
        if (!mirror) return null;
        try {
            const body = await datatablesApi.get(table.id);
            apply(body);
            setError(null);
            return body && body.datatable;
        } catch (e) {
            setError((e as Error).message || 'mirror');
            return null;
        } finally {
            setLoading(false);
        }
    }, [mirror, table.id, apply]);

    useEffect(() => { if (mirror) reload(); }, [mirror, reload]);

    // The pulse, while watched.
    useEffect(() => {
        if (!mirror || !watching || !api) return undefined;
        let alive = true;
        const tick = async () => {
            try {
                const body = await api.pulse(table.id);
                if (!alive || !body) return;
                if (body.sync) setState(s => ({ ...(s || {}), sync: body.sync }));
                if (typeof body.dataVersion === 'number') {
                    // A moved version is a reload; the first answer only sets the baseline.
                    setDataVersion(prev => (prev === null || prev === body.dataVersion ? (prev === null ? body.dataVersion : prev) : body.dataVersion));
                }
                setError(null);
            } catch (e) {
                if (alive) setError((e as Error).message || 'pulse');
            } finally {
                if (alive) timer.current = setTimeout(tick, PULSE_MS);
            }
        };
        tick();
        return () => { alive = false; if (timer.current) clearTimeout(timer.current); };
    }, [mirror, watching, table.id, api]);

    const watch = useCallback((on: unknown) => setWatching(!!on), []);

    const refreshNow = useCallback(async () => {
        if (!mirror || !api) return null;
        try {
            const body = await api.refresh(table.id);
            if (body && body.sync) setState(s => ({ ...(s || {}), sync: body.sync }));
            setError(null);
            // Re-read once: the answer carries the sync block but not row_count.
            const fresh = await reload();
            if (fresh && typeof fresh.dataVersion === 'number') setDataVersion(fresh.dataVersion);
            else setDataVersion(v => (v === null ? 0 : v + 1));   // a manual refresh always reloads the rows
            return body;
        } catch (e) {
            setError((e as Error).message || 'refresh');
            throw e;
        }
    }, [mirror, api, table.id, reload]);

    const update = useCallback(async (patch: Json) => {
        const body = await api.update(table.id, patch);
        apply(body);
        return body;
    }, [api, table.id, apply]);

    const setRelations = useCallback(async (relations: Json[]) => {
        const body = await api.setRelations(table.id, relations);
        apply(body);
        return body;
    }, [api, table.id, apply]);

    const relink = useCallback(async (body: Json | null = null) => {
        const answer = await api.relink(table.id, body);
        apply(answer);
        return answer;
    }, [api, table.id, apply]);

    if (!mirror) return null;
    return {
        kind: table.managedKind,
        source: state ? state.source : null,
        sync: state ? state.sync : null,
        dataVersion,
        watching,
        watch,
        loading,
        error,
        reload,
        refreshNow,
        update,
        setRelations,
        relink,
    };
}

/** What the hook hands a mirror's panels (it is null for a table that mirrors nothing). */
export type SourceMirror = NonNullable<ReturnType<typeof useSourceMirror>>;

export { PULSE_MS };
