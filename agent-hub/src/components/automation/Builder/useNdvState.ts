import { useCallback, useState } from 'react';
import scopedStorage from '../../../utils/scopedStorage';
import { densityForOpen } from './flow/settings/formDensity';
import useFormModePreference from './flow/settings/useFormModePreference';

/**
 * Which step's editor drawer is open, and how much of it shows. Split out of
 * BuilderShell without a change in behaviour.
 */
export default function useNdvState() {
    // Node Detail View (NDV) — the focused Input|Parameters|Output editor for
    // ONE step. `ndvStepId` is the step being edited (null = closed). Replaces
    // the old node-anchored peek + multi-pin dock.
    const [ndvStepId, setNdvStepId] = useState<any>(null);
    // How much of the step to show: a single click opens the SMALL editor
    // (just the settings the step needs), a double click the full
    // Input|Parameters|Output workspace.
    //
    // The drawer reopens the way it was LEFT: the last quick/full choice is
    // remembered per user (user request 2026-09-03). A double click still
    // forces the full view — formDensity.densityForOpen. Inside an open
    // drawer the ⤢ / shrink buttons and the column toggles switch freely,
    // and every switch updates the memory.
    const [ndvDensity, setNdvDensityState] = useState(() => (scopedStorage.getItem('ndvDensity') === 'full' ? 'full' : 'quick'));
    const setNdvDensity = useCallback((d: any) => {
        const next = d === 'full' ? 'full' : 'quick';
        setNdvDensityState(next);
        scopedStorage.setItem('ndvDensity', next);
    }, []);
    // How much of the step's FORM exists (Simple / All options) — the user's
    // persisted choice, orthogonal to the gesture-owned density above.
    const { mode: ndvMode, setMode: setNdvMode } = useFormModePreference();
    const openNdv = useCallback((id: any, density: any) => {
        if (!id) return;
        setNdvStepId(id);
        setNdvDensity(densityForOpen(density, scopedStorage.getItem('ndvDensity')));
    }, [setNdvDensity]);
    const closeNdv = useCallback(() => setNdvStepId(null), []);

    return { ndvStepId, setNdvStepId, ndvDensity, setNdvDensity, ndvMode, setNdvMode, openNdv, closeNdv };
}
