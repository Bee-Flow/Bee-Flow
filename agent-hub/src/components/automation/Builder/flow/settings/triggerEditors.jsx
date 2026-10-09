// Trigger + form-page step editors, extracted verbatim from SettingsForm.jsx
// (same §WS5 decomposition as formPrimitives/triggerFilters). Rendered by the
// SettingsForm dispatch; state stays in the parent's draft via `set`.
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getIntegrationIcon } from '../../../../../config/integrationIcons';
import TriggerWebhookPanel from '../../webhooks/TriggerWebhookPanel';
import AccordionSection from '../AccordionSection';
import ScheduleBuilder from '../ScheduleBuilder';
import { CAN_BE_SECONDARY } from '../stepPalette';
import { defaultTriggerLabel, isGeneratedTriggerLabel } from '../triggerLabels';
import TriggerProviderPicker from '../TriggerProviderPicker';
import FieldDesigner from './fieldDesigner';
import FormBuilderFields, { defaultFormPageDeclaration, defaultFormEndingDeclaration } from './FormBuilderFields';
import { FormRow, inputClass } from './formPrimitives';
import FormTriggerFields from './FormTriggerFields';
import { FILTER_FORM_BY_KEY } from './triggerFilters';
import { useTranslation } from '../../../../../hooks/useTranslation';

function TriggerFields({ draft, set, setNested, errorSections = new Set(), catalog = null, automation = null, stepId = null, isSecondaryTrigger = false, onTestSubmit = null, onRenameField = null }) {
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
                        <AgentCallFields draft={draft} set={set} onRenameField={onRenameField} />
                    )}
                    {kind === 'schedule' && (
                        <ScheduleBuilder
                            cron={draft.scheduleCron || ''}
                            tz={draft.scheduleTz || 'Europe/Amsterdam'}
                            onChange={({ cron, tz }) => {
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
                        <FormTriggerFields draft={draft} set={set} automation={automation} stepId={stepId} onTestSubmit={onTestSubmit} onRenameField={onRenameField} />
                    )}
                </AccordionSection>
            )}
        </>
    );
}

// Labels for providers that can appear in SAVED configs but are absent from
// the dynamic catalog list (hidden, e.g. github; or availability revoked).
// Fallback for anything else: the raw id. Never used to LIST a provider.
const LEGACY_PROVIDER_LABELS = {
    'gmail': 'Gmail',
    'google-calendar': 'Google Calendar',
    'google-drive': 'Google Drive',
    'nextcloud': 'Nextcloud',
    'support': 'Support Inbox',
    'msgraph': 'Microsoft 365 (Outlook)',
    'github': 'GitHub',
};

/**
 * Provider + event selects with per-event filter sub-form. The provider list
 * is dynamic — only providers the backend catalog reports as available to
 * this user. A configured-but-unlisted provider renders as a preserved
 * "(not available)" option and is never blanked or mutated. Switching the
 * provider auto-snaps the event to that provider's default AND clears the
 * filter — different events have incompatible filter shapes, so carrying old
 * fields over would just produce validation warnings.
 */
function AppEventFields({ draft, set, setNested, catalog = null }) {
    const { t } = useTranslation();
    // Normalizer: tolerate a stale/cached backend that still serves string[].
    const rawProviders = catalog?.triggers?.find(t => t.kind === 'app_event')?.providers || [];
    const providerDefs = rawProviders.map(p =>
        typeof p === 'string' ? { id: p, label: p, defaultEvent: '', events: [] } : p);

    const [pickerOpen, setPickerOpen] = useState(false);
    const provider = draft.appProvider || '';
    const currentDef = providerDefs.find(p => p.id === provider) || null;
    const events = currentDef?.events || [];
    const event = draft.appEventName || currentDef?.defaultEvent || '';
    const knownEvent = events.some(ev => ev.id === event);
    const selectedEvent = events.find(ev => ev.id === event) || null;

    const onProviderChange = (next) => {
        const def = providerDefs.find(p => p.id === next);
        set('appProvider', next);
        set('appEventName', def?.defaultEvent || def?.events?.[0]?.id || '');
        set('filter', {});
    };
    const onEventChange = (next) => {
        set('appEventName', next);
        set('filter', {});
    };

    // One-shot auto-snap: a fresh trigger starts with no provider; pick the
    // first available one once the catalog is present. Ref-guarded so a
    // subsequent manual clear-to-'' can't retrigger it.
    const snappedRef = useRef(false);
    useEffect(() => {
        if (snappedRef.current) return;
        if (!draft.appProvider && providerDefs.length > 0) {
            snappedRef.current = true;
            onProviderChange(providerDefs[0].id);
        }
    });

    if (!provider && providerDefs.length === 0) {
        return (
            <div className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                {t('automations.trigger_editors.no_event_sources_are_available_to', 'No event sources are available to you yet. Connect an app (e.g. Gmail or Nextcloud) in Settings → Integrations first.')}
            </div>
        );
    }

    const providerListed = !!currentDef;
    const setF = (k, v) => setNested('filter', k, v);
    const filter = draft.filter || {};
    const FilterForm = FILTER_FORM_BY_KEY[`${provider}.${event}`] || null;

    return (
        <>
            <FormRow label={t('automations.trigger_editors.app', 'App')}>
                {/* An app picker rather than a dropdown of ids: same overlay the
                    agent editor uses, so it carries the app's logo and shows
                    what that app can trigger on before you commit to it. */}
                <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    aria-label={t('automations.trigger_editors.choose_the_app_to_trigger_on', 'Choose the app to trigger on')}
                    className={`${inputClass()} flex items-center gap-2 text-left hover:bg-[var(--bg-tertiary)]`}
                >
                    {provider && (
                        <span className="w-5 h-5 flex items-center justify-center shrink-0">{getIntegrationIcon(provider)}</span>
                    )}
                    <span className="truncate flex-1">
                        {provider
                            ? (currentDef?.label || LEGACY_PROVIDER_LABELS[provider] || provider)
                            : 'Choose an app…'}
                        {provider && !providerListed && ' (not available)'}
                    </span>
                    <ChevronDown size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                </button>
                {pickerOpen && (
                    <TriggerProviderPicker
                        providers={providerDefs}
                        selected={provider}
                        onPick={onProviderChange}
                        onClose={() => setPickerOpen(false)}
                    />
                )}
                {provider && !providerListed && (
                    <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-1 leading-snug">
                        {t('automations.trigger_editors.this_app_isn_t_available_to', 'This app isn\'t available to you right now (integration not connected or not permitted for your account). The trigger is kept as configured, but it may not fire.')}
                    </div>
                )}
            </FormRow>
            <FormRow label={t('automations.trigger_editors.event', 'Event')}>
                <select value={event} onChange={(e) => onEventChange(e.target.value)} className={inputClass()}>
                    {event && !knownEvent && (
                        <option value={event}>{event}{providerListed ? ' (unknown event)' : ''}</option>
                    )}
                    {events.map(ev => (
                        <option key={ev.id} value={ev.id}>{ev.label}</option>
                    ))}
                </select>
            </FormRow>
            {/* The explanation travels with the event that needs it — this used
                to name Nextcloud regardless of which provider was selected. */}
            {selectedEvent?.deliverability === 'connector' && (
                <div className="text-[11px] text-amber-600 dark:text-amber-400 leading-snug">
                    {selectedEvent.deliverabilityNote
                        || 'This event needs an extra connector that isn’t available yet — it will not fire.'}
                </div>
            )}

            {FilterForm && <FilterForm filter={filter} setFilter={setF} />}
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
function LayerInputFields({ draft, set, onRenameField = null }) {
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
function AgentCallFields({ draft, set, onRenameField = null }) {
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
        </>
    );
}

/**
 * Studio App trigger (trigger.kind === 'app_trigger') — the automation is fired
 * by a Studio App action with DECLARED TYPED INPUTS. Same row editor as the
 * flowlet/agent params, plus the `file` type: a file input arrives at run
 * time as { fileId, name, mime, size, url } (bind .url into steps that fetch
 * the file). Server contract: server/automation/appTriggerContract.js —
 * identifier names, no leading underscore.
 */
function AppTriggerFields({ draft, set, onRenameField = null }) {
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

const FORM_WAIT_CHOICES = [
    { value: 900, label: '15 minutes' },
    { value: 3600, label: '1 hour' },
    { value: 86400, label: '24 hours' },
    { value: 7 * 24 * 3600, label: '7 days' },
];

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
function FormPageFields({ draft, set, stepId, onFocusField, previewSample, errorSections = new Set(), onRenameField = null }) {
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
                <FormBuilderFields
                    form={form}
                    onChange={(next) => set('form', next)}
                    bindingBase={`steps.${stepId || 'this'}.output`}
                    variant={isEnding ? 'ending' : 'input'}
                    allowVariables
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    onRenameField={onRenameField}
                />
            </AccordionSection>
            {/* Its own section key, not 'options': how long the automation waits
                for a real person is a first-class decision, so it must not
                disappear behind the advanced-density filter. */}
            {!isEnding && (
                <AccordionSection stepType="form_page" sectionKey="waiting" title={t('automations.trigger_editors.waiting', 'Waiting')} defaultOpen forceOpen={errorSections.has('waiting')}>
                    <FormRow label={t('automations.trigger_editors.wait_for_an_answer', 'Wait for an answer')} hint={t('automations.trigger_editors.after_this_the_automation_gives_up', 'After this the automation gives up and the run fails.')}>
                        <select
                            aria-label={t('automations.trigger_editors.wait_for_an_answer', 'Wait for an answer')}
                            value={draft.waitSeconds ?? 3600}
                            onChange={(e) => set('waitSeconds', Number(e.target.value))}
                            className={inputClass()}
                        >
                            {FORM_WAIT_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </select>
                    </FormRow>
                </AccordionSection>
            )}
        </>
    );
}

export { TriggerFields, FormPageFields };
