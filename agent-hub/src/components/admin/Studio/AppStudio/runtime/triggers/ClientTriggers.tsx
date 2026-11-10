import { useCallback, useMemo, useRef } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { showToast } from '../actionRunner/core';
import { buildScope } from '../RuntimeContext';
import { definitionReadsUi, useUiScope } from '../uiState';
import { useScreenOpen, useScreenTimers, useWatchers } from './useClientTriggers';
import type { RunSlot } from './useClientTriggers';
import type { ActionState, Vars } from '../actionRunner/core';
import type { DataState } from '../DataContext';

/**
 * The client triggers of a LIVE run (schema 3): the open screen's onOpen and timers, and
 * the app's watchers. Renders nothing. Only the run surface mounts it (pages/apps/
 * AppRunPage.tsx RunBody, which the public page uses too): the editor canvas, its preview
 * and the headless screenshot entry never do, so "a screenshot must never fire an action"
 * holds by construction. On a public page the definition holds only the public actions,
 * and the server ships only the watchers of those (definitionKeys/watchers.js).
 */

export interface ClientTriggersProps {
    definition: Record<string, unknown> | null | undefined;
    screenId: string | null;
    screenParams: unknown;
    runAction: RunSlot;
    actionState: ActionState;
    dataState: DataState;
    vars: Vars;
    forms: Record<string, unknown>;
    currentUser: unknown;
}

export default function ClientTriggers({
    definition, screenId, screenParams, runAction, actionState, dataState, vars, forms, currentUser,
}: ClientTriggersProps) {
    const { t } = useTranslation();
    const ui = useUiScope(definitionReadsUi(definition));
    // The scope a visibleWhen on this screen reads, so a watcher's formula means the same thing.
    const scope = useMemo(() => buildScope({
        actionState, dataState, forms, vars, currentUser, ui,
        screen: { id: screenId, params: screenParams || {} },
    }), [actionState, dataState, forms, vars, currentUser, ui, screenId, screenParams]);

    useScreenOpen(definition, screenId, screenParams, runAction);
    useScreenTimers(definition, screenId, runAction);

    const told = useRef(new Set<string>());
    const onDisabled = useCallback((id: string) => {
        if (told.current.has(id)) return;
        told.current.add(id);
        showToast('danger', t('studio_apps_triggers.runtime.watcher_paused', 'A watcher of this app ran too often and was paused: "{id}". Reload the page to start it again.', { id: id || '?' }));
    }, [t]);
    useWatchers(definition, scope, runAction, onDisabled);
    return null;
}
