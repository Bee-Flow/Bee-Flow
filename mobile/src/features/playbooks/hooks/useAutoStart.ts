/**
 * Start the phase on stage when it becomes ready — the web's stages each do
 * this on mount — but only the phases the phone can see through: the ones the
 * server runs (table, fill, design, compliance) and access, which the person
 * decides here. Once per phase and attempt, so a re-render or a poll that
 * lands before the answer can never fire it twice.
 */

import { useEffect, useRef } from 'react';

import { shouldAutoStart } from '../model/handoff';
import type { PlaybookEvent } from '../model/phaseMachine';
import type { Phase, Playbook } from '../model/types';

export function useAutoStart(
    playbook: Playbook | null | undefined,
    active: Phase | null,
    dispatch: (event: PlaybookEvent) => Promise<unknown>,
): void {
    const started = useRef<string | null>(null);
    const live = playbook?.status === 'active';
    const stamp = active ? `${playbook?.id}:${active.key}:${active.attempt}` : null;
    const ready = live && shouldAutoStart(active);
    useEffect(() => {
        if (!ready || !stamp || !active || started.current === stamp) return;
        started.current = stamp;
        void dispatch({ type: 'start', key: active.key });
    }, [ready, stamp, active, dispatch]);
}
