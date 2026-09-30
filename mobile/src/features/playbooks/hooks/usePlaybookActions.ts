/**
 * Every press on an open playbook — the web's usePlaybook.dispatch.
 *
 * An event becomes one wire (model/phaseMachine patchFor), the phase list
 * moves at once (the optimistic step), and the server's answer replaces the
 * whole entity. A refusal that carries the current playbook (every 409 does)
 * is adopted rather than retried; anything else re-reads it. The error stays
 * on screen in words — a 409 is not always "changed elsewhere": the route
 * also answers 409 for an illegal transition or a missing artifact, and
 * those must reach the person rather than a button that silently did nothing.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '@/core/api/client';

import { sendWire } from '../api/endpoints';
import { playbookKeys } from '../api/keys';
import { readPlaybook } from '../api/readers';
import { OPTIMISTIC, applyPhaseResult, patchFor, type PlaybookEvent } from '../model/phaseMachine';
import type { Playbook } from '../model/types';

export interface PlaybookActions {
    /** Resolves to the server's playbook, or null when the write was refused. */
    dispatch: (event: PlaybookEvent, base?: Playbook | null) => Promise<Playbook | null>;
    busy: boolean;
    error: unknown;
    clearError: () => void;
    /** Counts `version_conflict` refusals, so the screen can say "changed elsewhere" once per conflict. */
    conflicts: number;
}

function optimistic(pb: Playbook, event: PlaybookEvent): Playbook | null {
    const kind = OPTIMISTIC[event.type];
    if (!kind || !('key' in event)) return null;
    const extra = event as { artifacts?: Record<string, unknown>; summary?: string; error?: string };
    return { ...pb, phases: applyPhaseResult(pb.phases, event.key, { kind, artifacts: extra.artifacts, summary: extra.summary, error: extra.error }) };
}

export function usePlaybookActions(id: string): PlaybookActions {
    const queryClient = useQueryClient();
    const key = playbookKeys.detail(id);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const [conflicts, setConflicts] = useState(0);

    const adoptOrReload = (pb: Playbook | null) => {
        if (pb) queryClient.setQueryData(key, pb);
        else void queryClient.invalidateQueries({ queryKey: key });
    };

    const dispatch = async (event: PlaybookEvent, base: Playbook | null = null): Promise<Playbook | null> => {
        const current = base ?? queryClient.getQueryData<Playbook | null>(key) ?? null;
        const wire = patchFor(event, current);
        if (!current || !wire) return current;
        // A poll landing mid-write would put the old phases back under the optimistic ones.
        await queryClient.cancelQueries({ queryKey: key });
        const moved = optimistic(current, event);
        if (moved) queryClient.setQueryData(key, moved);
        setBusy(true);
        try {
            const next = await sendWire(id, wire);
            adoptOrReload(next);
            setError(null);
            void queryClient.invalidateQueries({ queryKey: playbookKeys.list });
            return next;
        } catch (e) {
            adoptOrReload(e instanceof ApiError ? readPlaybook(e.body) : null);
            if (e instanceof ApiError && e.code === 'version_conflict') setConflicts((n) => n + 1);
            setError(e);
            return null;
        } finally {
            setBusy(false);
        }
    };

    return { dispatch, busy, error, clearError: () => setError(null), conflicts };
}
