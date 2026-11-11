import { lazy, Suspense } from 'react';
import { Plus, X } from 'lucide-react';
import IconButton from '@/components/shared/IconButton';
import toast from '@/components/shared/Toast';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { ApiError, errorBody } from '@/api/mutate';
import { INPUT_CLS } from '../inspector/panels/kit';
import { useActionChoices } from '../inspector/ThenAlsoRun';
import {
    MAX_EVERY_MINUTES, MAX_SERVER_TRIGGERS, clampMinutes, definitionTriggers, isInterval, isWebhookTrigger, newScheduleTrigger, newWebhookTrigger, setTriggers, withEnabled,
    type ServerTrigger, type TriggerSchedule,
} from '../state/serverTriggerOps';
import { triggersApi, useTriggerState, useTriggerSwitch, type TriggerView, type TriggersApi } from './serverTriggersApi';
import type { AppDefinition } from '../inspector/appDefinition';

// Only an app with a webhook trigger loads its address, secret and delivery list.
const WebhookTriggerDetails = lazy(() => import('./WebhookTriggerDetails'));

/**
 * The app's server triggers in the Logic tab (schema 3, definition.triggers): "at these times,
 * run that action", on the server, with nobody at the page. The list edits the draft; what is
 * ARMED is read from the server and only exists for a published app. A trigger runs as the
 * owner of the app, which the panel says in so many words.
 */

export interface ServerTriggersPanelProps {
    appId: string;
    definition: AppDefinition;
    onCommit: (definition: AppDefinition) => void;
    disabled?: boolean;
    api?: TriggersApi;
}

const ADD_BTN = 'inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';
const LINK_BTN = 'text-xs text-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50';

function browserZone(): string {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function when(iso: string | null, locale: string | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function lastRunText(view: TriggerView, t: TranslateFn, locale: string | undefined): string | null {
    if (!view.lastFiredAt) return null;
    const time = when(view.lastFiredAt, locale);
    switch (view.lastStatus) {
        case 'success': return t('studio_apps_schedule.panel.last_success', 'Last run {time}: finished', { time });
        case 'running': return t('studio_apps_schedule.panel.last_running', 'Last run {time}: still going', { time });
        case 'skipped': return t('studio_apps_schedule.panel.last_skipped', 'Skipped {time}', { time });
        case 'refused': return t('studio_apps_schedule.panel.last_refused', 'Did not run {time}', { time });
        case 'cancelled': return t('studio_apps_schedule.panel.last_cancelled', 'Last run {time}: cancelled', { time });
        default: return t('studio_apps_schedule.panel.last_failed', 'Last run {time}: failed', { time });
    }
}

/** What the server says about one trigger: armed or not, the next fire, the last run, a pause and its reason. */
function TriggerStatus({ view, published, onSwitch, busy }: { view: TriggerView | undefined; published: boolean | undefined; onSwitch: (enabled: boolean) => void; busy: boolean }) {
    const { t, locale } = useTranslation();
    if (published === undefined) return null;
    if (!view || view.state === 'none') {
        return (
            <p className="text-xs text-[var(--text-tertiary)]" data-trigger-state="none">
                {published
                    ? t('studio_apps_schedule.panel.not_armed_published', 'Not armed yet. Publish the app again to switch this trigger on.')
                    : t('studio_apps_schedule.panel.not_armed_draft', 'Not armed. A trigger only runs once the app is published.')}
            </p>
        );
    }
    const last = lastRunText(view, t, locale);
    return (
        <div className="flex flex-col gap-0.5 text-xs text-[var(--text-secondary)]" data-trigger-state={view.state}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                {view.state === 'armed'
                    ? <span className="font-medium text-[var(--success)]">{t('studio_apps_schedule.panel.armed', 'Armed')}</span>
                    : <span className="font-medium text-[var(--warning)]">{t('studio_apps_schedule.panel.paused', 'Paused')}</span>}
                {view.state === 'armed' && view.nextFireAt ? <span>{t('studio_apps_schedule.panel.next', 'Next run {time}', { time: when(view.nextFireAt, locale) })}</span> : null}
                {last ? <span>{last}</span> : null}
                <button type="button" className={LINK_BTN} disabled={busy} onClick={() => onSwitch(view.state !== 'armed')}>
                    {view.state === 'armed' ? t('studio_apps_schedule.panel.switch_off', 'Switch off') : t('studio_apps_schedule.panel.switch_on', 'Switch on again')}
                </button>
            </div>
            {view.state === 'paused' && view.pausedCode === 'failures'
                ? <span className="text-[var(--error)]" role="status">{t('studio_apps_schedule.panel.paused_failures', 'Paused after {count} failed runs in a row. Fix the action, then switch the trigger on again.', { count: view.consecutiveFailures })}</span> : null}
            {view.lastError && view.lastStatus !== 'success' ? <span className="text-[var(--text-tertiary)]">{view.lastError}</span> : null}
            {view.live === false ? <span>{t('studio_apps_schedule.panel.not_live', 'You changed this trigger. The published app still runs the old one until you publish again.')}</span> : null}
        </div>
    );
}

/** The schedule of one trigger: an interval in minutes, or a cron with its time zone. */
function ScheduleFields({ schedule, onChange, disabled }: { schedule: TriggerSchedule | undefined; onChange: (next: TriggerSchedule) => void; disabled: boolean }) {
    const { t } = useTranslation();
    const interval = isInterval(schedule);
    const cron = !interval && schedule ? schedule : { cron: '0 8 * * 1-5', tz: browserZone() };
    return (
        <>
            <select
                className={`${INPUT_CLS} w-36`}
                value={interval ? 'interval' : 'cron'}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value === 'interval' ? { everyMinutes: 60 } : cron)}
                aria-label={t('studio_apps_schedule.panel.mode', 'How the times are given')}
            >
                <option value="interval">{t('studio_apps_schedule.panel.mode_interval', 'Every … minutes')}</option>
                <option value="cron">{t('studio_apps_schedule.panel.mode_cron', 'At set times')}</option>
            </select>
            {interval ? (
                <input
                    type="number" className={`${INPUT_CLS} w-24`} min={1} max={MAX_EVERY_MINUTES} value={schedule.everyMinutes} disabled={disabled}
                    onChange={(e) => onChange({ everyMinutes: clampMinutes(e.target.value) })}
                    aria-label={t('studio_apps_schedule.panel.every_minutes', 'Every how many minutes')}
                />
            ) : (
                <>
                    <input
                        type="text" className={`${INPUT_CLS} w-36 font-mono`} value={cron.cron} placeholder="0 8 * * 1-5" spellCheck={false} disabled={disabled}
                        onChange={(e) => onChange({ cron: e.target.value, tz: cron.tz })}
                        aria-label={t('studio_apps_schedule.panel.cron', 'Times as minute, hour, day of month, month, day of week')}
                    />
                    <input
                        type="text" className={`${INPUT_CLS} w-44`} value={cron.tz} placeholder="Europe/Amsterdam" spellCheck={false} disabled={disabled}
                        onChange={(e) => onChange({ cron: cron.cron, tz: e.target.value })}
                        aria-label={t('studio_apps_schedule.panel.tz', 'Time zone')}
                    />
                </>
            )}
        </>
    );
}

/** One button per kind of trigger; each adds a trigger of that kind for the first action. */
function AddButtons({ disabled, onAdd }: { disabled: boolean; onAdd: (make: (taken: ServerTrigger[], actionId: string) => ServerTrigger) => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap gap-2">
            <button type="button" className={ADD_BTN} disabled={disabled} onClick={() => onAdd(newScheduleTrigger)}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('studio_apps_schedule.panel.add', 'Add a schedule')}
            </button>
            <button type="button" className={ADD_BTN} disabled={disabled} onClick={() => onAdd(newWebhookTrigger)}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('studio_apps_h5.add', 'Add a webhook')}
            </button>
        </div>
    );
}

export default function ServerTriggersPanel({ appId, definition, onCommit, disabled = false, api = triggersApi }: ServerTriggersPanelProps) {
    const { t } = useTranslation();
    const choices = useActionChoices(definition);
    const triggers = definitionTriggers(definition);
    // The armed state is only asked for an app that has, or had, a trigger: an app without one makes no request.
    const state = useTriggerState(api, appId, triggers.length > 0 && !!appId);
    const flip = useTriggerSwitch(api, appId);
    const commit = (list: ServerTrigger[]) => {
        const next = setTriggers(definition, list);
        if (next !== definition) onCommit(next);
    };
    const patch = (i: number, change: (trigger: ServerTrigger) => ServerTrigger) => commit(triggers.map((tr, j) => (j === i ? change(tr) : tr)));
    const first = choices[0]?.id;
    const views = new Map((state.data?.triggers ?? []).map((v) => [v.id, v]));
    const onSwitch = (triggerId: string, enabled: boolean) => flip.mutate({ triggerId, enabled }, {
        onError: (err) => {
            const reason = err instanceof ApiError ? errorBody(err)?.error : null;
            toast.error(typeof reason === 'string' && reason ? reason : t('studio_apps_schedule.panel.switch_failed', 'The trigger could not be switched. Try again.'));
        },
    });

    return (
        <section className="mt-6" data-testid="logic-server-triggers">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('studio_apps_schedule.panel.title', 'On a schedule')}</h3>
                    <p className="text-xs text-[var(--text-tertiary)]">
                        {t('studio_apps_schedule.panel.desc', 'A trigger runs an action on the server at set times, with nobody at the page. It only runs once the app is published.')}
                    </p>
                    <p className="text-xs font-medium text-[var(--text-secondary)]" data-testid="triggers-runs-as">
                        {t('studio_apps_schedule.panel.runs_as', 'It runs as the owner of this app: with the owner’s access to every row, the owner’s mailbox and the owner’s automations.')}
                    </p>
                </div>
                {triggers.length < MAX_SERVER_TRIGGERS && first ? <AddButtons disabled={disabled} onAdd={(make) => commit([...triggers, make(triggers, first)])} /> : null}
            </div>
            {state.isError ? <p className="mb-2 text-xs text-[var(--error)]" role="alert">{t('studio_apps_schedule.panel.state_failed', 'Whether the triggers are armed could not be read.')}</p> : null}
            {triggers.map((tr, i) => (
                <div key={tr.id || i} className="mb-3 flex flex-col gap-1" data-app-trigger={tr.id}>
                    <div className="flex flex-wrap items-center gap-2">
                        {isWebhookTrigger(tr)
                            ? <span className="text-xs font-medium text-[var(--text-secondary)]" data-trigger-kind="webhook">{t('studio_apps_h5.when', 'When another system calls its address')}</span>
                            : <ScheduleFields schedule={tr.schedule} disabled={disabled} onChange={(schedule) => patch(i, (cur) => ({ ...cur, schedule }))} />}
                        <select
                            className={`${INPUT_CLS} min-w-[10rem] flex-1`} value={tr.actionId} disabled={disabled}
                            onChange={(e) => patch(i, (cur) => ({ ...cur, actionId: e.target.value }))}
                            aria-label={t('studio_apps_schedule.panel.action', 'Action to run')}
                        >
                            {choices.some((c) => c.id === tr.actionId) ? null : <option value={tr.actionId}>{tr.actionId}</option>}
                            {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                        <label className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                            <input type="checkbox" checked={tr.enabled !== false} disabled={disabled} onChange={(e) => patch(i, (cur) => withEnabled(cur, e.target.checked))} />
                            {t('studio_apps_schedule.panel.enabled', 'On when published')}
                        </label>
                        <IconButton ariaLabel={t('studio_apps_schedule.panel.remove', 'Remove this trigger')} onClick={() => commit(triggers.filter((_, j) => j !== i))} disabled={disabled}>
                            <X />
                        </IconButton>
                    </div>
                    <TriggerStatus view={views.get(tr.id)} published={state.data?.published} busy={flip.isPending} onSwitch={(enabled) => onSwitch(tr.id, enabled)} />
                    {isWebhookTrigger(tr) && state.data ? (
                        <Suspense fallback={null}><WebhookTriggerDetails appId={appId} triggerId={tr.id} disabled={disabled} /></Suspense>
                    ) : null}
                </div>
            ))}
            {triggers.length ? (
                <p className="text-xs text-[var(--text-tertiary)]">
                    {t('studio_apps_schedule.panel.steps_hint', 'The action may only hold steps that work without a page: no navigation, dialogs, messages or refreshes. Saving the app tells you which step is in the way.')}
                </p>
            ) : null}
            {!first ? <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_schedule.panel.no_actions', 'Add an action to the app first: a trigger runs one of its actions.')}</p> : null}
        </section>
    );
}
