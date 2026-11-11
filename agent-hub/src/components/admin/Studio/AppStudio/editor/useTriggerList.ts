import toast from '@/components/shared/Toast';
import useTranslation from '@/hooks/useTranslation';
import { ApiError, errorBody } from '@/api/mutate';
import { setTriggers, type ServerTrigger } from '../state/serverTriggerOps';
import { useTriggerState, useTriggerSwitch, type TriggersApi } from './serverTriggersApi';
import type { AppDefinition } from '../inspector/appDefinition';

/**
 * What every part of the Triggers area does with the list (ServerTriggersPanel, RecordTriggersPanel):
 * write the whole list to the draft, read what the server armed (only when `ask`, so an app without a
 * trigger makes no request), and switch one armed trigger on or off with a toast when that fails.
 */
export function useTriggerList(api: TriggersApi, appId: string, definition: AppDefinition, onCommit: (definition: AppDefinition) => void, ask: boolean) {
    const { t } = useTranslation();
    const state = useTriggerState(api, appId, ask && !!appId);
    const flip = useTriggerSwitch(api, appId);
    const commit = (list: ServerTrigger[]) => {
        const next = setTriggers(definition, list);
        if (next !== definition) onCommit(next);
    };
    const views = new Map((state.data?.triggers ?? []).map((v) => [v.id, v]));
    const onSwitch = (triggerId: string, enabled: boolean) => flip.mutate({ triggerId, enabled }, {
        onError: (err) => {
            const reason = err instanceof ApiError ? errorBody(err)?.error : null;
            toast.error(typeof reason === 'string' && reason ? reason : t('studio_apps_schedule.panel.switch_failed', 'The trigger could not be switched. Try again.'));
        },
    });
    return { state, flip, commit, views, onSwitch };
}
