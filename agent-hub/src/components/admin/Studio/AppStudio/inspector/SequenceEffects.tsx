import Disclosure from '@/components/shared/Disclosure';
import useTranslation from '@/hooks/useTranslation';
import { EffectEditor } from './ActionEffectEditors';
import type { ActionEffect, AppAction, AppDefinition } from './appDefinition';

interface SequenceEffectsProps {
    action: AppAction;
    commitAction: (next: AppAction) => void;
    definition?: AppDefinition | null;
    disabled?: boolean;
}

/**
 * What a sequence does once, when it has ended: a toast and/or a screen to open, on success and on failure.
 * The same bounded effects a run_automation has (they never chain into further actions); anything longer is
 * a step at the end of the sequence. An empty slot is removed, so a sequence without effects stays as it was.
 */
export default function SequenceEffects({ action, commitAction, definition = null, disabled = false }: SequenceEffectsProps) {
    const { t } = useTranslation();
    const screens = definition?.screens || [];
    const setEffect = (slot: 'onSuccess' | 'onError', effect: ActionEffect | null) => {
        const next: AppAction = { ...action };
        if (effect) next[slot] = effect; else delete next[slot];
        commitAction(next);
    };
    return (
        <div data-sequence-effects="true">
            <Disclosure title={t('studio_apps_dynamic_text.effects_title', 'When it ends')}>
                <div className="flex flex-col gap-2">
                    <EffectEditor
                        label={t('studio_apps_insp.actions.on_success', 'On success')}
                        effect={action.onSuccess}
                        screens={screens}
                        onChange={(e) => setEffect('onSuccess', e)}
                        disabled={disabled}
                    />
                    <EffectEditor
                        label={t('studio_apps_insp.actions.on_error', 'On error')}
                        effect={action.onError}
                        screens={screens}
                        onChange={(e) => setEffect('onError', e)}
                        disabled={disabled}
                    />
                </div>
            </Disclosure>
        </div>
    );
}
