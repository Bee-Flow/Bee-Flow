import { Plus, X } from 'lucide-react';
import IconButton from '@/components/shared/IconButton';
import toast from '@/components/shared/Toast';
import useTranslation from '@/hooks/useTranslation';
import { ApiError, errorBody } from '@/api/mutate';
import useAppTables, { fieldsForTable, type AppTable } from '../bi/useAppTables';
import { INPUT_CLS } from '../inspector/panels/kit';
import { useActionChoices } from '../inspector/ThenAlsoRun';
import { MAX_SERVER_TRIGGERS, definitionTriggers, setTriggers, withEnabled, type ServerTrigger } from '../state/serverTriggerOps';
import {
    RECORD_EVENTS, isRecordTrigger, newRecordTrigger, withAllowPublic, withEvent, withField, withTable, withWhen,
    type RecordEvent, type RecordTrigger,
} from '../state/recordTriggerOps';
import { TriggerStatus } from './ServerTriggersPanel';
import { triggersApi, useTriggerState, useTriggerSwitch, type TriggersApi } from './serverTriggersApi';
import type { AppDefinition } from '../inspector/appDefinition';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * The app's record triggers in the Logic tab (schema 3, definition.triggers of kind "record"):
 * "when a row of this table is added, changed or deleted, run that action", on the server. The
 * list edits the draft; what is ARMED is read from the server and only exists for a published
 * app. The panel says in so many words that the action runs as the owner whoever changed the
 * row, and which changes start it.
 */

export interface RecordTriggersPanelProps {
    appId: string;
    definition: AppDefinition;
    onCommit: (definition: AppDefinition) => void;
    disabled?: boolean;
    api?: TriggersApi;
    /** The app's tables; left out, they are read from the server. */
    tables?: AppTable[];
}

const ADD_BTN = 'inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';
const CHECK = 'flex items-center gap-1 text-xs text-[var(--text-secondary)]';

function eventLabel(event: RecordEvent, t: TranslateFn): string {
    if (event === 'create') return t('studio_apps_h4.panel.event_create', 'Added');
    if (event === 'update') return t('studio_apps_h4.panel.event_update', 'Changed');
    return t('studio_apps_h4.panel.event_delete', 'Deleted');
}

/** The form of one record trigger: its table, its events, the fields it watches and its condition. */
function RecordTriggerFields({ trigger, tables, disabled, onChange }: { trigger: RecordTrigger; tables: AppTable[]; disabled: boolean; onChange: (next: RecordTrigger) => void }) {
    const { t } = useTranslation();
    const known = tables.some((tb) => tb.id === trigger.tableId || tb.key === trigger.tableId);
    const fields = fieldsForTable(tables, trigger.tableId);
    const events = Array.isArray(trigger.on) ? trigger.on : [];
    return (
        <>
            <div className="flex flex-wrap items-center gap-2">
                <select
                    className={`${INPUT_CLS} min-w-[9rem]`} value={trigger.tableId} disabled={disabled}
                    onChange={(e) => onChange(withTable(trigger, e.target.value))}
                    aria-label={t('studio_apps_h4.panel.table', 'Table to watch')}
                >
                    {known ? null : <option value={trigger.tableId}>{t('studio_apps_h4.panel.table_missing', '{table} (no longer in the app)', { table: trigger.tableId })}</option>}
                    {tables.map((tb) => <option key={tb.id} value={tb.id}>{tb.name || tb.key}</option>)}
                </select>
                <fieldset className="flex flex-wrap items-center gap-2" aria-label={t('studio_apps_h4.panel.events', 'Start when a row is')}>
                    <span className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_h4.panel.events', 'Start when a row is')}</span>
                    {RECORD_EVENTS.map((event) => (
                        <label key={event} className={CHECK}>
                            <input type="checkbox" checked={events.includes(event)} disabled={disabled} onChange={(e) => onChange(withEvent(trigger, event, e.target.checked))} />
                            {eventLabel(event, t)}
                        </label>
                    ))}
                </fieldset>
            </div>
            {events.includes('update') && fields.length ? (
                <fieldset className="flex flex-wrap items-center gap-2" aria-label={t('studio_apps_h4.panel.fields', 'Only when one of these fields changed')}>
                    <span className="text-xs text-[var(--text-tertiary)]">
                        {t('studio_apps_h4.panel.fields', 'Only when one of these fields changed')}
                        {trigger.fields?.length ? '' : ` (${t('studio_apps_h4.panel.fields_any', 'Any field')})`}
                    </span>
                    {fields.map((f) => (
                        <label key={f.key} className={CHECK}>
                            <input type="checkbox" checked={!!trigger.fields?.includes(f.key)} disabled={disabled} onChange={(e) => onChange(withField(trigger, f.key, e.target.checked))} />
                            {f.name || f.key}
                        </label>
                    ))}
                </fieldset>
            ) : null}
            <input
                type="text" className={`${INPUT_CLS} w-full font-mono`} value={trigger.when ?? ''} placeholder={'trigger.record.row.status == "done"'} spellCheck={false} disabled={disabled}
                onChange={(e) => onChange(withWhen(trigger, e.target.value))}
                aria-label={t('studio_apps_h4.panel.when', 'Only if (formula)')}
                title={t('studio_apps_h4.panel.when_hint', 'For example trigger.record.row.status == "done". Read the row as trigger.record.row, the row before the change as trigger.record.before, and the event as trigger.record.event.')}
            />
            <label className={CHECK}>
                <input type="checkbox" checked={trigger.allowPublicWrites === true} disabled={disabled} onChange={(e) => onChange(withAllowPublic(trigger, e.target.checked))} />
                {t('studio_apps_h4.panel.allow_public', 'Also start on changes by visitors of a public page')}
            </label>
            {trigger.allowPublicWrites === true ? (
                <p className="text-xs text-[var(--warning)]" role="note">
                    {t('studio_apps_h4.panel.allow_public_hint', 'Anyone who can reach the public page can then start this action. It may not send e-mail, start an automation, ask for an approval or delete rows.')}
                </p>
            ) : null}
        </>
    );
}

/** The panel with the tables it was handed. */
function RecordTriggersList({ appId, definition, onCommit, disabled = false, api = triggersApi, tables }: RecordTriggersPanelProps & { tables: AppTable[] }) {
    const { t } = useTranslation();
    const choices = useActionChoices(definition);
    const triggers = definitionTriggers(definition);
    const mine = triggers.some(isRecordTrigger);
    // The armed state is only asked for an app that has a record trigger (the schedule panel shares the answer).
    const state = useTriggerState(api, appId, mine && !!appId);
    const flip = useTriggerSwitch(api, appId);
    const commit = (list: ServerTrigger[]) => {
        const next = setTriggers(definition, list);
        if (next !== definition) onCommit(next);
    };
    const patch = (i: number, next: ServerTrigger) => commit(triggers.map((tr, j) => (j === i ? next : tr)));
    const firstAction = choices[0]?.id;
    const firstTable = tables[0]?.id;
    const views = new Map((state.data?.triggers ?? []).map((v) => [v.id, v]));
    const onSwitch = (triggerId: string, enabled: boolean) => flip.mutate({ triggerId, enabled }, {
        onError: (err) => {
            const reason = err instanceof ApiError ? errorBody(err)?.error : null;
            toast.error(typeof reason === 'string' && reason ? reason : t('studio_apps_schedule.panel.switch_failed', 'The trigger could not be switched. Try again.'));
        },
    });

    return (
        <section className="mt-3" data-testid="logic-record-triggers">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    {/* A part of the Triggers area (ServerTriggersPanel holds its heading): this one names its kind. */}
                    <h4 className="text-xs font-semibold text-[var(--text-primary)]">{t('studio_apps_h4.panel.title', 'When a record changes')}</h4>
                    <p className="text-xs text-[var(--text-tertiary)]">
                        {t('studio_apps_h4.panel.desc', 'A record trigger runs an action on the server when a row of a table is added, changed or deleted. It only runs once the app is published.')}
                    </p>
                    <p className="text-xs font-medium text-[var(--text-secondary)]" data-testid="record-triggers-runs-as">
                        {t('studio_apps_h4.panel.runs_as', 'It runs as the owner of this app, whoever changed the row: with the owner’s access to every row, the owner’s mailbox and the owner’s automations.')}
                    </p>
                </div>
                {triggers.length < MAX_SERVER_TRIGGERS && firstAction && firstTable ? (
                    <button type="button" className={ADD_BTN} disabled={disabled} onClick={() => commit([...triggers, newRecordTrigger(triggers, firstAction, firstTable)])}>
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('studio_apps_h4.panel.add', 'Add a record trigger')}
                    </button>
                ) : null}
            </div>
            {triggers.map((tr, i) => (!isRecordTrigger(tr) ? null : (
                <div key={tr.id || i} className="mb-3 flex flex-col gap-1.5 rounded border border-[var(--border-subtle)] p-2" data-app-trigger={tr.id}>
                    <RecordTriggerFields trigger={tr} tables={tables} disabled={disabled} onChange={(next) => patch(i, next)} />
                    <div className="flex flex-wrap items-center gap-2">
                        <select
                            className={`${INPUT_CLS} min-w-[10rem] flex-1`} value={tr.actionId} disabled={disabled}
                            onChange={(e) => patch(i, { ...tr, actionId: e.target.value })}
                            aria-label={t('studio_apps_schedule.panel.action', 'Action to run')}
                        >
                            {choices.some((c) => c.id === tr.actionId) ? null : <option value={tr.actionId}>{tr.actionId}</option>}
                            {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                        <label className={CHECK}>
                            <input type="checkbox" checked={tr.enabled !== false} disabled={disabled} onChange={(e) => patch(i, withEnabled(tr, e.target.checked))} />
                            {t('studio_apps_schedule.panel.enabled', 'On when published')}
                        </label>
                        <IconButton ariaLabel={t('studio_apps_schedule.panel.remove', 'Remove this trigger')} onClick={() => commit(triggers.filter((_, j) => j !== i))} disabled={disabled}>
                            <X />
                        </IconButton>
                    </div>
                    <TriggerStatus view={views.get(tr.id)} published={state.data?.published} busy={flip.isPending} onSwitch={(enabled) => onSwitch(tr.id, enabled)} />
                </div>
            )))}
            <p className="text-xs text-[var(--text-tertiary)]" data-testid="record-triggers-fires-on">
                {t('studio_apps_h4.panel.fires_on', 'It starts on a change someone makes in the app (in a grid or a form, or through an add, update or delete step for one row) and on such a step of another trigger. It does not start on imports, connector sync, rows the AI builder writes, test runs, or steps that change many rows at once.')}
                {' '}
                {t('studio_apps_h4.panel.loops', 'A trigger never starts on a row its own run changed, and a chain of triggers that start each other stops after a few runs.')}
            </p>
            {!firstTable ? <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_h4.panel.no_tables', 'Add a table to the app first: a record trigger watches one of its tables.')}</p> : null}
        </section>
    );
}

/** The panel in the editor: the tables come from the app's data model. */
function RecordTriggersWithTables(props: RecordTriggersPanelProps) {
    const { tables } = useAppTables(props.appId);
    return <RecordTriggersList {...props} tables={tables} />;
}

export default function RecordTriggersPanel(props: RecordTriggersPanelProps) {
    return props.tables ? <RecordTriggersList {...props} tables={props.tables} /> : <RecordTriggersWithTables {...props} />;
}
