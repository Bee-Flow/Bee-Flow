import React from 'react';
import Toggle from '@/components/shared/Toggle';
import FormField from '@/components/shared/FormField';
import useTranslation from '@/hooks/useTranslation';
import BindingField from './panels/BindingField';
import { INPUT_CLS } from './panels/kit';
import { childStepLists } from '@shared/appDefinition/stepFlow.mjs';
import type { AppAction, AppDefinition, AppNode } from './appDefinition';

/** The variable names a sequence writes (set_variable, resultVar), in first-seen order. */
export function writtenVarNames(steps: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
    if (!Array.isArray(steps) || depth > 12) return out;
    for (const s of steps) {
        if (!s || typeof s !== 'object') continue;
        const step = s as Record<string, unknown>;
        if (step.kind === 'set_variable' && typeof step.name === 'string' && step.name) out.add(step.name);
        if (typeof step.resultVar === 'string' && step.resultVar) out.add(step.resultVar);
        for (const child of childStepLists(step)) writtenVarNames(child, out, depth + 1);
    }
    return out;
}

/** The options a progress variable can name: what the sequence writes, then the declared variables. */
function progressChoices(action: AppAction, definition: AppDefinition | null | undefined): string[] {
    const names = writtenVarNames(action.steps);
    for (const v of Array.isArray(definition?.variables) ? definition.variables : []) {
        if (v && typeof v.name === 'string' && v.name) names.add(v.name);
    }
    return [...names];
}

interface ActionRunOptionsProps {
    action: AppAction;
    commitAction: (next: AppAction) => void;
    definition?: AppDefinition | null;
    node?: AppNode | null;
    disabled?: boolean;
}

/**
 * How a sequence runs: in the page (the default), or as a server job that keeps running
 * when the page is closed, optionally locked per item and with a progress text.
 */
export default function ActionRunOptions({ action, commitAction, definition = null, node = null, disabled = false }: ActionRunOptionsProps) {
    const { t } = useTranslation();
    const background = action.background === true;
    const set = (patch: Partial<AppAction>) => {
        const next: AppAction = { ...action, ...patch };
        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
        commitAction(next);
    };
    const choices = progressChoices(action, definition);
    return (
        <div className="space-y-3" data-action-run-options="true">
            <Toggle
                size="sm"
                label={t('studio_apps_insp.actions.background_label', 'Keep running when the page is closed')}
                description={t('studio_apps_insp.actions.background_hint', 'Runs on the server; the page shows the progress and the result. Navigation and dialogs cannot be part of it; messages and refreshes show at the end.')}
                checked={background}
                onChange={(on: boolean) => set(on ? { background: true } : { background: undefined, lockKey: undefined, progressVar: undefined })}
                ariaLabel={t('studio_apps_insp.actions.background_label', 'Keep running when the page is closed')}
                disabled={disabled}
            />
            {background && (
                <>
                    <BindingField
                        label={t('studio_apps_insp.actions.lock_key_label', 'Only once at a time per')}
                        hint={t('studio_apps_insp.actions.lock_key_hint', 'While a run with the same value is going, a second start is refused. For example the record id.')}
                        value={action.lockKey as never}
                        onChange={(v: unknown) => set({ lockKey: v ?? undefined })}
                        definition={definition as never}
                        node={node as never}
                        disabled={disabled}
                    />
                    <FormField label={t('studio_apps_insp.actions.progress_var_label', 'Progress text')} hint={t('studio_apps_insp.actions.progress_var_hint', 'The variable a "set variable" step writes; its text shows while the run goes.')}>
                        <select
                            className={INPUT_CLS}
                            value={typeof action.progressVar === 'string' ? action.progressVar : ''}
                            onChange={(e) => set({ progressVar: e.target.value || undefined })}
                            disabled={disabled}
                            aria-label={t('studio_apps_insp.actions.progress_var_label', 'Progress text')}
                        >
                            <option value="">{t('studio_apps_insp.actions.progress_var_none', 'The current step')}</option>
                            {choices.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                    </FormField>
                </>
            )}
        </div>
    );
}
