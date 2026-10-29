import { ExternalLink, FlaskConical, X } from 'lucide-react';
import { EffectEditor, ReturnedEcho } from './ActionEffectEditors';
import AutomationTile, { automationHref } from './AutomationTile';
import { ContractDrift, MappingRow } from './MappingRows';
import AutomationPicker from './AutomationPicker';
import SentInputsTable from './SentInputsTable';
import { SKIP_REASONS } from './testPayload';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import Disclosure from '@/components/shared/Disclosure';
import FormField from '@/components/shared/FormField';
import IconButton from '@/components/shared/IconButton';
import Spinner from '@/components/shared/Spinner';
import type { AppAction } from './appDefinition';
import type { EventWiring, SkippedInput } from './useEventWiring';

/**
 * The run_automation editor of an event slot (ActionsSection's EventWiring):
 * which automation, what gets sent, what comes back, and the test run with
 * its result. Moved out of ActionsSection.tsx verbatim; `wiring` is the
 * slot's useEventWiring state.
 */

export interface RunAutomationEditorProps {
    wiring: EventWiring;
    action: AppAction;
    disabled: boolean;
    titleFor: ((automationId?: string | null) => string | null) | null;
}

/**
 * One line saying why a parameter did not travel with the test run.
 *
 * Every reason gets its own sentence: "a file cannot be sent from here" and
 * "that form is not on screen" lead to completely different fixes, and one
 * vague line covering both would send people looking in the wrong place.
 */
export function skipSentence(t: TranslateFn, entry: SkippedInput) {
    const name = entry.field ? `${entry.param} (${entry.field})` : entry.param;
    switch (entry.reason) {
        case SKIP_REASONS.FILE:
            return t(
                'app_studio.inspector.test_skip_file',
                '{name} — a file cannot be sent from here, so the automation runs without it.',
                { name },
            );
        case SKIP_REASONS.NO_SCREEN:
            return t(
                'app_studio.inspector.test_skip_no_screen',
                '{name} — that form is not on the canvas, so there was no value to send.',
                { name },
            );
        case SKIP_REASONS.NO_VALUE:
            return t(
                'app_studio.inspector.test_skip_no_value',
                '{name} — the form has no field by that name, so nothing was sent for it.',
                { name },
            );
        // The automation ASKS for the parameter, but there is no rule saying where it
        // comes from. A different sentence than “nothing is wired to it”: there is
        // a rule that is empty or incomprehensible; here there is no rule at all —
        // and that is exactly what the drift bar above already offers to resolve.
        case SKIP_REASONS.NO_MAPPING:
            return t(
                'app_studio.inspector.test_skip_no_mapping',
                '{name} — the automation asks for it but this button has no row for it, so it was left out.',
                { name },
            );
        default:
            return t(
                'app_studio.inspector.test_skip_unmapped',
                '{name} — nothing is wired to it, so it was left out.',
                { name },
            );
    }
}

function WhatGetsSent({ wiring, action, disabled }: Omit<RunAutomationEditorProps, 'titleFor'>) {
    const { t } = useTranslation();
    const { paramMetaByName, formFields, targetTrigger, mappingEntries, setMapping, removeMapping, renameMapping, addMapping } = wiring;
    return (
        <FormField label={t('app_studio.inspector.whats_sent', 'What gets sent')}>
            <div className="flex flex-col gap-2">
                {/* The ANSWER first. Reading "what does this
                    button send" used to mean parsing three
                    form controls per parameter. */}
                <SentInputsTable
                    paramMetaByName={paramMetaByName}
                    inputMapping={action.inputMapping}
                    formFields={formFields}
                    showViewerRow={targetTrigger?.kind === 'app_trigger'}
                />
                {/* Drift stays OUT of the disclosure: what
                    the automation asks for now, versus what
                    this action sends, is not an advanced
                    detail — it is the reason a run fails. */}
                <ContractDrift
                    paramMeta={paramMetaByName}
                    mapped={mappingEntries.map(([p]) => p)}
                    onAdd={(name) => setMapping(name, { kind: 'static', value: '' })}
                    onRemove={removeMapping}
                    disabled={disabled}
                />
                <Disclosure title={t('app_studio.inspector.change_whats_sent', 'Change what gets sent')}>
                    <div className="flex flex-col gap-2">
                        {mappingEntries.map(([param, mapping], i) => (
                            // Keyed by POSITION: the param name is
                            // the value being typed, so keying on it
                            // remounts the row on every keystroke.
                            <MappingRow
                                key={i}
                                param={param}
                                mapping={mapping}
                                formFields={formFields}
                                paramMeta={paramMetaByName?.[param] || null}
                                takenNames={mappingEntries.map(([p]) => p).filter((p) => p !== param)}
                                onChange={(v) => setMapping(param, v)}
                                onRename={(v) => renameMapping(param, v)}
                                onRemove={() => removeMapping(param)}
                                disabled={disabled}
                            />
                        ))}
                        <button
                            type="button"
                            onClick={addMapping}
                            disabled={disabled}
                            className="px-3 py-1.5 text-xs rounded-md border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors disabled:opacity-50"
                        >
                            {t('studio_apps_insp.actions.add_parameter', '+ Add parameter')}
                        </button>
                    </div>
                </Disclosure>
            </div>
        </FormField>
    );
}

function WhatComesBack({ wiring, action, disabled }: Omit<RunAutomationEditorProps, 'titleFor'>) {
    const { t } = useTranslation();
    const { screens, setEffect } = wiring;
    return (
        <FormField label={t('app_studio.inspector.whats_returned', 'What comes back')}>
            <div className="flex flex-col gap-2">
                <ReturnedEcho action={action} screens={screens} />
                <Disclosure title={t('app_studio.inspector.all_options', 'All options')}>
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
        </FormField>
    );
}

function TestRunControls({ wiring, action, disabled, titleFor }: RunAutomationEditorProps) {
    const { t } = useTranslation();
    const { test, setConfirmTest, formName, structuralSkips, confirmTest, runTest } = wiring;
    return (
        <>
            <button
                type="button"
                onClick={() => setConfirmTest(true)}
                disabled={disabled || !action.automationId || test?.status === 'running'}
                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {test?.status === 'running' ? <Spinner size="xs" /> : <FlaskConical className="w-4 h-4" />}
                {t('app_studio.inspector.test_with_screen', 'Test with what is on screen')}
            </button>
            <p className="-mt-1 text-xs text-[var(--text-secondary)]">
                {formName
                    ? t(
                        'app_studio.inspector.test_caption',
                        'Runs the automation for real, with the values standing in this form right now, and opens the run in the builder.',
                    )
                    : t(
                        'app_studio.inspector.test_caption_no_form',
                        'Runs the automation for real and opens the run in the builder. This button is not in a form, so there are no screen values to send.',
                    )}
            </p>
            {/* What can never travel, said BEFORE the click.
                Someone who tests with half the input and does
                not know it draws the wrong conclusion about
                the automation. */}
            {structuralSkips.length ? (
                <ul className="-mt-1 flex flex-col gap-0.5 text-xs text-amber-600">
                    {structuralSkips.map((s) => (
                        <li key={`always-${s.param}`}>{skipSentence(t, s)}</li>
                    ))}
                </ul>
            ) : null}
            <ConfirmDialog
                open={confirmTest}
                title={t('studio_apps_insp.actions.run_now_title', 'Run “{name}” now?', { name: titleFor?.(action.automationId) || t('studio_apps_insp.actions.this_automation', 'this automation') })}
                description={t('studio_apps_insp.actions.run_now_description', 'This is the real run, not a rehearsal — anything it sends or writes actually happens.')}
                confirmLabel={t('studio_apps_insp.actions.run_it', 'Run it')}
                onConfirm={runTest}
                onCancel={() => setConfirmTest(false)}
            />
        </>
    );
}

function TestResultPanel({ wiring, action }: Pick<RunAutomationEditorProps, 'wiring' | 'action'>) {
    const { t } = useTranslation();
    const { test, setTest, appRef } = wiring;
    if (!test || test.status === 'running') return null;
    return (
        <div className="rounded-md border border-[var(--border-subtle)] overflow-hidden">
            <div className="flex items-center justify-between px-2.5 py-1.5 bg-[var(--bg-tertiary)]">
                <span className={`text-[11px] font-semibold uppercase tracking-wide ${test.status === 'error' ? 'text-rose-500' : 'text-emerald-500'}`}>
                    {test.status === 'error' ? t('studio_apps_insp.actions.test_failed', 'Test failed') : t('studio_apps_insp.actions.test_result', 'Test result')}
                </span>
                <IconButton ariaLabel={t('studio_apps_insp.actions.dismiss_test_result', 'Dismiss test result')} onClick={() => setTest(null)} size="sm">
                    <X />
                </IconButton>
            </div>
            {/* The way to the run itself, always an
                ordinary link: openRunInBuilder already
                tried a tab, and a blocked pop-up must
                not be the end of the road. */}
            <div className="flex flex-col gap-1 px-2.5 pt-2">
                <a
                    href={automationHref(action.automationId, appRef, { view: 'runs', runId: test.runId || null }) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 self-start text-xs font-medium text-[var(--accent-primary)] hover:underline"
                >
                    {test.runId
                        ? t('app_studio.inspector.test_open_run', 'Open this run in the builder')
                        : t('app_studio.inspector.test_open_runs', 'Open this automation’s runs in the builder')}
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>
                {/* And what the run did NOT get. Said
                    again here because the reasons that
                    depend on the moment (a form that
                    was not on screen) can only be known
                    once it has been pressed. */}
                {test.skipped?.length ? (
                    <ul className="flex flex-col gap-0.5 text-xs text-amber-600">
                        {test.skipped.map((s) => (
                            <li key={`sent-${s.param}`}>{skipSentence(t, s)}</li>
                        ))}
                    </ul>
                ) : null}
            </div>
            <pre className="text-xs p-2.5 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                {test.status === 'error' ? test.error : JSON.stringify(test.body, null, 2)}
            </pre>
        </div>
    );
}

export default function RunAutomationEditor({ wiring, action, disabled, titleFor }: RunAutomationEditorProps) {
    const { t } = useTranslation();
    const { automationRows, setPickerOpen, appRef, pickerOpen, onPickAutomation, formFields } = wiring;
    return (
        <>
            <FormField label={t('app_studio.inspector.which_automation', 'Which automation')}>
                <AutomationTile
                    automationId={action.automationId || null}
                    row={action.automationId ? automationRows?.[action.automationId] || null : null}
                    onChoose={() => setPickerOpen(true)}
                    onCreate={() => setPickerOpen(true)}
                    disabled={disabled}
                    appRef={appRef}
                />
            </FormField>

            <WhatGetsSent wiring={wiring} action={action} disabled={disabled} />

            <WhatComesBack wiring={wiring} action={action} disabled={disabled} />

            <TestRunControls wiring={wiring} action={action} disabled={disabled} titleFor={titleFor} />

            <TestResultPanel wiring={wiring} action={action} />

            <AutomationPicker
                open={pickerOpen}
                onClose={() => setPickerOpen(false)}
                onPick={onPickAutomation}
                formFields={formFields}
                appRef={appRef}
            />
        </>
    );
}
