// Trigger + form-page step editors, extracted verbatim from SettingsForm.jsx
// (same §WS5 decomposition as formPrimitives/triggerFilters). Rendered by the
// SettingsForm dispatch; state stays in the parent's draft via `set`.
import TriggerWebhookPanel from '../../webhooks/TriggerWebhookPanel';
import AccordionSection from '../AccordionSection';
import ScheduleBuilder from '../ScheduleBuilder';
import { CAN_BE_SECONDARY } from '../stepPalette';
import { defaultTriggerLabel, isGeneratedTriggerLabel } from '../triggerLabels';
import AgentBindingsSection from './agentBindings/AgentBindingsSection';
import FieldDesigner from './fieldDesigner';
import FormPageEditor from './FormPageEditor';
import FormPageWaiting from './FormPageWaiting';
import FormPageWhen from './FormPageWhen';
import { defaultFormPageDeclaration, defaultFormEndingDeclaration } from './FormBuilderFields';
import { FormRow, inputClass } from './formPrimitives';
import FormTriggerFields from './FormTriggerFields';
import type { FormPageFieldsProps, ParamFieldsProps, TriggerFieldsProps } from './triggerEditors.types';
import { useTranslation } from '@/hooks/useTranslation';
import { AppEventFields } from './AppEventFields';
function TriggerFields({ draft, set, setNested, errorSections = new Set(), catalog = null, automation = null, stepId = null, isSecondaryTrigger = false, onTestSubmit = null, onRenameField = null, formEditor = null }: TriggerFieldsProps) {
    const { t } = useTranslation();
    const kind = draft.kind || 'manual';
    // A flowlet's trigger declares its input contract instead of firing — no
    // schedule/manual/webhook switch, just the params editor.
    if (kind === 'layer_input') {
        return (
            <AccordionSection stepType="trigger" sectionKey="inputs" title={t('automations.trigger_editors.inputs', 'Inputs')} defaultOpen forceOpen={errorSections.has('config')}>
                <LayerInputFields draft={draft} set={set} onRenameField={onRenameField} />
            </AccordionSection>
        );
    }
    const hasKindForm = kind === 'agent_call' || kind === 'schedule' || kind === 'app_event' || kind === 'app_trigger' || kind === 'webhook' || kind === 'form';
    const kindTitle = kind === 'agent_call' ? 'Agent tool'
        : kind === 'schedule' ? 'Schedule'
        : kind === 'app_trigger' ? 'App inputs'
        : kind === 'webhook' ? 'Endpoint'
        : kind === 'form' ? 'Form'
        : 'Event';
    return (
        <>
            <FormRow label={t('automations.trigger_editors.trigger_kind', 'Trigger kind')} hint={isSecondaryTrigger ? 'Additional triggers can be webhooks, app events or schedules — manual, form, agent and app triggers can only be the primary trigger.' : undefined}>
                <select
                    value={kind}
                    onChange={(e) => {
                        const next = e.target.value;
                        // Rename the node along with its kind unless the user
                        // named it by hand. Without this the canvas node and
                        // this modal's own header both kept reading "Manual"
                        // after a switch to Schedule (BFSF-339).
                        if (isGeneratedTriggerLabel(draft.label)) set('label', defaultTriggerLabel(next));
                        set('kind', next);
                    }}
                    className={inputClass()}
                >
                    {/* A SECONDARY trigger (definition.triggers[]) may only be
                        webhook / app_event / schedule (stepPalette.js
                        CAN_BE_SECONDARY mirrors the validator's
                        SECONDARY_TRIGGER_KINDS) — offering the other kinds made
                        every pick fail the save with a confusing error (C7). A
                        legacy invalid kind stays visible-but-disabled: opening
                        the panel must never silently change routing. */}
                    {!isSecondaryTrigger && <option value="manual">{t('automations.trigger_editors.manual_runs_only_when_you_click', 'Manual — runs only when you click Run')}</option>}
                    {!isSecondaryTrigger && <option value="form">{t('automations.trigger_editors.form_a_public_page_people_fill', 'Form — a public page people fill in')}</option>}
                    <option value="schedule">{t('automations.trigger_editors.schedule_runs_on_a_timer', 'Schedule — runs on a timer')}</option>
                    <option value="webhook">{t('automations.trigger_editors.webhook_inbound_https_post', 'Webhook — inbound HTTPS POST')}</option>
                    <option value="app_event">{t('automations.trigger_editors.app_event_e_g_new_gmail', 'App event — e.g. new Gmail email')}</option>
                    {!isSecondaryTrigger && <option value="agent_call">{t('automations.trigger_editors.agent_callable_from_chat', 'Agent — callable from chat')}</option>}
                    {!isSecondaryTrigger && <option value="app_trigger">{t('automations.trigger_editors.studio_app_called_by_an_app', 'Studio App — called by an app action')}</option>}
                    {isSecondaryTrigger && !CAN_BE_SECONDARY.has(kind) && (
                        <option value={kind} disabled>{t('automations.trigger_editors.unsupported_here', '(unsupported here)')} {kind}</option>
                    )}
                </select>
            </FormRow>
            {hasKindForm && (
                <AccordionSection stepType="trigger" sectionKey="config" title={kindTitle} defaultOpen forceOpen={errorSections.has('config')}>
                    {kind === 'agent_call' && (
                        <AgentCallFields draft={draft} set={set} onRenameField={onRenameField} automationId={automation?.id || null} />
                    )}
                    {kind === 'schedule' && (
                        <ScheduleBuilder
                            cron={draft.scheduleCron || ''}
                            tz={draft.scheduleTz || 'Europe/Amsterdam'}
                            onChange={({ cron, tz }: { cron: string; tz: string }) => {
                                set('scheduleCron', cron);
                                set('scheduleTz', tz);
                            }}
                        />
                    )}
                    {kind === 'app_event' && (
                        <AppEventFields draft={draft} set={set} setNested={setNested} catalog={catalog} />
                    )}
                    {kind === 'app_trigger' && (
                        <AppTriggerFields draft={draft} set={set} onRenameField={onRenameField} />
                    )}
                    {kind === 'webhook' && (
                        <TriggerWebhookPanel automation={automation} stepId={stepId} />
                    )}
                    {kind === 'form' && (
                        <FormTriggerFields draft={draft} set={set} automation={automation} stepId={stepId} onTestSubmit={onTestSubmit} onRenameField={onRenameField} formEditor={formEditor} />
                    )}
                </AccordionSection>
            )}
        </>
    );
}

/**
 * The type vocabulary of a declared parameter. Two sets, because the two
 * contracts genuinely differ: a flowlet or an agent tool takes JSON, a Studio
 * App action can also hand over a FILE. The order is the order the select
 * shows, and it is the server's (appTriggerContract.js).
 */
const CONTRACT_TYPES = [
    { value: 'string', label: 'string' },
    { value: 'number', label: 'number' },
    { value: 'boolean', label: 'boolean' },
    { value: 'object', label: 'object' },
    { value: 'array', label: 'array' },
];

const APP_TRIGGER_TYPES = [
    { value: 'string', label: 'text' },
    { value: 'number', label: 'number' },
    { value: 'boolean', label: 'boolean' },
    { value: 'array', label: 'array' },
    { value: 'object', label: 'json' },
    { value: 'file', label: 'file (pdf / word / excel / image)' },
];

/**
 * Editor for a flowlet's input contract (trigger kind 'layer_input').
 *
 * The description is not decoration: `stepContract.stepParams` reads it and
 * CallContractFields renders it as the hint on the caller's input row, so this
 * is the only place the person wiring a flowlet up can be told what a
 * parameter expects. It round-trips already — extractFormState keeps
 * `step.params` verbatim and buildPatch writes `description` back — it simply
 * had no box.
 */
function LayerInputFields({ draft, set, onRenameField = null }: ParamFieldsProps) {
    const { t } = useTranslation();
    return (
        <FormRow label={t('automations.trigger_editors.flowlet_inputs', 'Flowlet inputs')} hint={t('automations.trigger_editors.parameters_this_flowlet_accepts_inside_the', 'Parameters this flowlet accepts. Inside the flowlet, bind to them as trigger.output.<name>.')}>
            <FieldDesigner
                rows={draft.params}
                onChange={(next) => set('params', next)}
                types={CONTRACT_TYPES}
                addLabel="Add input"
                removeLabel="Remove input"
                emptyNote="No inputs yet — the flowlet will receive an empty payload."
                namePrefix="input"
                descriptionPlaceholder="description (shown where this flowlet is called)"
                onRenameField={onRenameField}
                takenError="Another input on this flowlet already binds that name."
            />
        </FormRow>
    );
}

/**
 * Agent trigger — the automation is exposed to the model as a function tool
 * (trigger.kind === 'agent_call'). The author declares the tool name, a
 * description the model reads to decide when to call it, and the input
 * parameters — rendered by the shared field designer, which is now literally
 * the same row editor as the flowlet's and the Studio App trigger's rather
 * than a third copy of one that looked like it.
 */
function AgentCallFields({ draft, set, onRenameField = null, automationId = null }: ParamFieldsProps & { automationId?: string | null }) {
    const { t } = useTranslation();
    return (
        <>
            <FormRow label={t('automations.trigger_editors.tool_name', 'Tool name')} hint={t('automations.trigger_editors.what_the_agent_calls_lowercased_sanitized', 'What the agent calls. Lowercased & sanitized; blank → automation_<id>.')}>
                <input
                    type="text"
                    value={draft.toolName || ''}
                    onChange={(e) => set('toolName', e.target.value)}
                    placeholder="summarise_inbox"
                    className={inputClass() + ' font-mono'}
                />
            </FormRow>
            <FormRow label={t('automations.trigger_editors.description', 'Description')} hint={t('automations.trigger_editors.the_agent_reads_this_to_decide', 'The agent reads this to decide when to call the automation.')}>
                <textarea
                    value={draft.description || ''}
                    onChange={(e) => set('description', e.target.value)}
                    rows={2}
                    // The server cap (MAX_TOOL_DESCRIPTION_LEN in agentCallContract.js): the
                    // agent is given no more than this, so the field does not accept more.
                    maxLength={1000}
                    placeholder={t('automations.trigger_editors.summarise_the_user_s_unread_email', 'Summarise the user\'s unread email and return the highlights.')}
                    className={inputClass()}
                />
            </FormRow>
            <FormRow label={t('automations.trigger_editors.input_parameters', 'Input parameters')} hint={t('automations.trigger_editors.arguments_the_agent_passes_bind_to', 'Arguments the agent passes. Bind to them in steps as trigger.output.<name>.')}>
                <FieldDesigner
                    rows={draft.params}
                    onChange={(next) => set('params', next)}
                    types={CONTRACT_TYPES}
                    addLabel="Add parameter"
                    removeLabel="Remove parameter"
                    emptyNote="No inputs — the agent calls it with no arguments."
                    namePrefix="arg"
                    defaults={{ description: '' }}
                    descriptionPlaceholder="description (helps the agent fill this in)"
                    onRenameField={onRenameField}
                    takenError="Another parameter of this tool already binds that name."
                />
            </FormRow>
            {/* Who may call it: saved through its own endpoint, not the definition. */}
            {automationId ? <AgentBindingsSection automationId={automationId} /> : null}
        </>
    );
}

/**
 * Studio App trigger (trigger.kind === 'app_trigger') — the automation is fired
 * by a Studio App action with DECLARED TYPED INPUTS. Same row editor as the
 * flowlet/agent params, plus the `file` type: a file input arrives at run
 * time as { fileId, name, mime, size, url } (bind .url into steps that fetch
 * the file). Server contract: server/core/automationModel/appTriggerContract.js —
 * identifier names, no leading underscore.
 */
function AppTriggerFields({ draft, set, onRenameField = null }: ParamFieldsProps) {
    const { t } = useTranslation();
    return (
        <FormRow label={t('automations.trigger_editors.app_inputs', 'App inputs')} hint={t('automations.trigger_editors.inputs_the_app_action_must_provide', 'Inputs the app action must provide. Bind them in steps as trigger.output.<name>; a file input arrives as { fileId, name, mime, size, url }.')}>
            <FieldDesigner
                rows={draft.params}
                onChange={(next) => set('params', next)}
                types={APP_TRIGGER_TYPES}
                addLabel="Add input"
                removeLabel="Remove input"
                emptyNote="No inputs yet — the app calls it with an empty payload."
                namePrefix="input"
                defaults={{ description: '' }}
                descriptionPlaceholder="description (shown to the app builder)"
                // The app builder's own field names are identifiers, so a
                // stray space or dash is a typo rather than an intent —
                // dropped as it is typed instead of refused on commit.
                sanitizeName={(s) => s.replace(/[^A-Za-z0-9_]/g, '')}
                onRenameField={onRenameField}
                takenError="Another input on this trigger already binds that name."
            />
        </FormRow>
    );
}

/**
 * A further page of the automation's public form.
 *
 * The page editor is the same one the trigger uses (FormBuilderFields) — what
 * is specific here is the wait window, which only an 'input' page has: it is
 * how long the run stays paused before giving up on the visitor.
 *
 * Unlike the trigger, every text on this page is template-interpolated at the
 * moment it is shown, so the slots get the {} picker and the Input panel can
 * drop values from earlier steps straight into them.
 */
function FormPageFields({ draft, set, stepId, onFocusField, previewSample, errorSections = new Set(), onRenameField = null, formEditor = null }: FormPageFieldsProps) {
    const { t } = useTranslation();
    const isEnding = draft.mode === 'ending';
    const form = draft.form || null;

    if (!form) {
        return (
            <AccordionSection stepType="form_page" sectionKey="config" title={t('automations.trigger_editors.page', 'Page')} defaultOpen forceOpen={errorSections.has('config')}>
                <p className="text-[11px] text-[var(--text-tertiary)] mb-2">
                    {isEnding
                        ? 'A closing page is the last thing the visitor sees. It can summarise what the automation did.'
                        : 'This asks the visitor one more thing, on the same link they are already on.'}
                </p>
                <button
                    type="button"
                    onClick={() => set('form', isEnding ? defaultFormEndingDeclaration() : defaultFormPageDeclaration())}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90"
                >
                    {t('automations.trigger_editors.create_the_page', 'Create the page')}
                </button>
            </AccordionSection>
        );
    }

    return (
        <>
            <AccordionSection stepType="form_page" sectionKey="config" title={t('automations.trigger_editors.page', 'Page')} defaultOpen forceOpen={errorSections.has('config')}>
                <div className="mb-3">
                    <FormPageWhen
                        when={typeof draft.when === 'string' ? draft.when : ''}
                        onChange={(next) => set('when', next)}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                    />
                </div>
                <FormPageEditor
                    form={form}
                    onChange={(next) => set('form', next)}
                    stepId={stepId}
                    formEditor={formEditor}
                    bindingBase={`steps.${stepId || 'this'}.output`}
                    variant={isEnding ? 'ending' : 'input'}
                    allowVariables
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    onRenameField={onRenameField}
                />
            </AccordionSection>
            {!isEnding && (
                <FormPageWaiting waitSeconds={draft.waitSeconds} onChange={(seconds) => set('waitSeconds', seconds)} forceOpen={errorSections.has('waiting')} />
            )}
        </>
    );
}

export { TriggerFields, FormPageFields };
