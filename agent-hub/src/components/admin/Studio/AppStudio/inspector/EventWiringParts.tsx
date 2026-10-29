import { Users, Workflow } from 'lucide-react';
import { NavigateParamsEditor, toneOptions } from './ActionEffectEditors';
import { describeAction } from './actionLabels';
import { joinNames, stepCount } from './actionRefs';
import { INPUT_CLS } from './panels/kit';
import useTranslation from '@/hooks/useTranslation';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import Toggle from '@/components/shared/Toggle';
import type { AppAction, AppDefinition, AppScreen, NavigateParam } from './appDefinition';

/**
 * The single-kind editors and notes of an event slot (ActionsSection's
 * EventWiring): the shared-action warning, the ways into the flow canvas,
 * the navigate / toast / open-url editors and the delete confirmation.
 * Moved out of ActionsSection.tsx verbatim.
 */

const FLOW_BUTTON = 'self-start inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]';

export function SharedActionNote({ sharedWith, onFork, disabled }: { sharedWith: string[]; onFork: () => void; disabled: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 flex flex-col gap-2">
            <p className="flex items-start gap-1.5 text-xs text-amber-600">
                <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                    {sharedWith.length === 1
                        ? t('studio_apps_insp.actions.shared_with_one', 'This is shared with {count} other component ({names}) — changes affect all of them.', { count: sharedWith.length, names: joinNames(sharedWith) })
                        : t('studio_apps_insp.actions.shared_with_many', 'This is shared with {count} other components ({names}) — changes affect all of them.', { count: sharedWith.length, names: joinNames(sharedWith) })}
                </span>
            </p>
            <button
                type="button"
                onClick={onFork}
                disabled={disabled}
                className="self-start px-2.5 py-1 text-xs rounded-md border border-amber-500/50 text-amber-600 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
            >
                {t('studio_apps_insp.actions.only_this_one', 'Only for this one')}
            </button>
        </div>
    );
}

/** The way into the step canvas under "All options". */
export function EditFlowButton({ onOpen, disabled }: { onOpen: () => void; disabled: boolean }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onOpen}
            disabled={disabled}
            className={FLOW_BUTTON}
        >
            <Workflow className="w-3.5 h-3.5" aria-hidden="true" />
            {t('app_studio.inspector.edit_the_flow', 'Edit the flow')}
        </button>
    );
}

/** A flow's step count, said where it is read, with the way into the canvas. */
export function SequenceSummary({ action, onOpen, disabled }: { action: AppAction; onOpen: () => void; disabled: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border-subtle)] p-2.5">
            <span className="text-xs text-[var(--text-primary)]">
                {stepCount(action) === 1
                    ? t('studio_apps_insp.actions.steps_one', '{count} step, run in order.', { count: stepCount(action) })
                    : t('studio_apps_insp.actions.steps_many', '{count} steps, run in order.', { count: stepCount(action) })}
            </span>
            <button
                type="button"
                onClick={onOpen}
                disabled={disabled}
                className={FLOW_BUTTON}
            >
                <Workflow className="w-3.5 h-3.5" aria-hidden="true" /> {t('app_studio.inspector.edit_the_flow', 'Edit the flow')}
            </button>
        </div>
    );
}

export interface KindEditorProps {
    action: AppAction;
    commitAction: (nextAction: AppAction) => void;
    disabled: boolean;
}

export function NavigateEditor({ action, commitAction, disabled, screens }: KindEditorProps & { screens: AppScreen[] }) {
    const { t } = useTranslation();
    return (
        <>
            <FormField label={t('studio_apps_insp.actions.screen', 'Screen')}>
                <select
                    className={INPUT_CLS}
                    value={action.screenId || ''}
                    onChange={(e) => commitAction({ ...action, screenId: e.target.value })}
                    disabled={disabled}
                    aria-label={t('studio_apps_insp.actions.target_screen', 'Target screen')}
                >
                    {screens.map((s) => (
                        <option key={s.id} value={s.id}>{s.name || s.id}</option>
                    ))}
                </select>
            </FormField>
            <NavigateParamsEditor
                params={action.params as Record<string, NavigateParam> | null | undefined}
                onChange={(params) => {
                    const { params: _drop, ...rest } = action;
                    commitAction(params ? { ...rest, params } : rest);
                }}
                disabled={disabled}
            />
        </>
    );
}

export function ToastEditor({ action, commitAction, disabled }: KindEditorProps) {
    const { t } = useTranslation();
    return (
        <>
            <FormField label={t('studio_apps_insp.actions.message', 'Message')}>
                <input
                    type="text"
                    className={INPUT_CLS}
                    value={action.message || ''}
                    onChange={(e) => commitAction({ ...action, message: e.target.value })}
                    placeholder={t('studio_apps_insp.actions.message_placeholder', 'What should the message say?')}
                    disabled={disabled}
                />
            </FormField>
            <FormField label={t('studio_apps_insp.actions.tone', 'Tone')}>
                <SegmentedControl
                    value={(action.tone as string | undefined) || 'info'}
                    onChange={(tone) => commitAction({ ...action, tone })}
                    options={toneOptions(t)}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_insp.actions.message_tone', 'Message tone')}
                />
            </FormField>
        </>
    );
}

export function OpenUrlEditor({ action, commitAction, disabled }: KindEditorProps) {
    const { t } = useTranslation();
    return (
        <>
            <FormField label={t('studio_apps_insp.actions.url', 'URL')} hint={t('studio_apps_insp.actions.url_hint', 'Must be an https URL.')}>
                <input
                    type="text"
                    className={INPUT_CLS}
                    value={action.url || ''}
                    onChange={(e) => commitAction({ ...action, url: e.target.value })}
                    placeholder={t('studio_apps_insp.actions.url_placeholder', 'https://…')}
                    disabled={disabled}
                    spellCheck={false}
                />
            </FormField>
            <Toggle
                label={t('studio_apps_insp.actions.open_new_tab', 'Open in a new tab')}
                checked={action.newTab !== false}
                onChange={(v) => commitAction({ ...action, newTab: v })}
                disabled={disabled}
                size="sm"
            />
        </>
    );
}

export interface DeleteActionDialogProps {
    open: boolean;
    actionId: string | null;
    action: AppAction;
    definition: AppDefinition;
    titleFor: ((automationId?: string | null) => string | null) | null;
    sharedWith: string[];
    resultShownBy: string[];
    onConfirm: () => void;
    onCancel: () => void;
}

export function DeleteActionDialog({ open, actionId, action, definition, titleFor, sharedWith, resultShownBy, onConfirm, onCancel }: DeleteActionDialogProps) {
    const { t } = useTranslation();
    return (
        <ConfirmDialog
            open={open}
            title={t('studio_apps_insp.actions.delete_title', 'Delete “{name}”?', { name: describeAction(actionId ?? '', action, definition, titleFor, t) })}
            description={(
                <>
                    {sharedWith.length ? (
                        <>{t('studio_apps_insp.actions.delete_shared', 'It stops happening on {names} too.', { names: joinNames(sharedWith) })} </>
                    ) : null}
                    {resultShownBy.length ? (
                        <>{resultShownBy.length === 1
                            ? t('studio_apps_insp.actions.delete_result_one', '{names} shows what it produced, and will be left empty.', { names: joinNames(resultShownBy) })
                            : t('studio_apps_insp.actions.delete_result_many', '{names} show what it produced, and will be left empty.', { names: joinNames(resultShownBy) })} </>
                    ) : null}
                    {t('studio_apps_insp.actions.cannot_undo', "This can't be undone.")}
                </>
            )}
            confirmLabel={t('studio_apps_insp.actions.delete_everywhere', 'Delete everywhere')}
            destructive
            onConfirm={onConfirm}
            onCancel={onCancel}
        />
    );
}
