/**
 * "Uses", the third row of a task's Settings (./CoworkTaskSettings.tsx), opened:
 *
 *   - its apps, as chips to switch on or off (the task's own list, PUT /api/cowork/:id `enabledApps`; the catalogue and
 *     what the organisation lets a task use while nobody watches come from ../useCoworkApps.ts);
 *   - how it works: the AI works it out every run, one of the owner's agents does it, or fixed steps (for an
 *     organisation with automations). Becoming fixed steps, or other apps for fixed steps, is "Save and test";
 *   - what it remembers and its spending limit (./TaskSetKeeps.tsx), each saved by itself.
 */
import { useModelTiersQuery } from '@/api/queries/modelTiers';
import CoworkModelPicker from '../CoworkModelPicker';
import { TINT } from '../coworkMotion';
import useCoworkApps from '../useCoworkApps';
import { MemoryPart, SpendingPart } from './TaskSetKeeps';
import { CHOICE_OFF, CHOICE_ON, PART_H, SaveBar } from './taskRows';
import { FIELD, LABEL, META } from './taskUi';
import { useSettingRow, type SettingRowForm } from './useTaskSettingsSave';
import { settingsPathForTab } from '@/authedApp/settingsRoutes';
import type { CoworkAgent } from '@/api/cowork.types';
import type { StepApp, TaskMode } from './coworkTaskModel';
import type { TaskDraft } from './coworkTaskSettingsModel';
import type { TranslateFn } from '@/hooks/useTranslation';

type Set = (patch: Partial<TaskDraft>) => void;

const MODES: Array<[TaskMode, string, string, string, string]> = [
    ['ai', 'cowork_task.how.ai', 'The AI works it out every run', 'cowork_task.mode.ai_line', 'It reads your sentence and works out the steps on every run. Most flexible, a bit slower.'],
    ['agent', 'cowork_task.mode.agent', 'An agent of yours does it', 'cowork_task.mode.agent_line', 'One of your own agents runs it, with its own instructions and apps.'],
    ['steps', 'cowork_task.mode.steps', 'Fixed steps', 'cowork_task.mode.steps_line', 'The same steps every run, with AI only where something must be written or judged. Fastest and cheapest.'],
];

/** How it works, in a few words, as the Uses row shows it while closed. */
export function howWords(mode: TaskMode, agentName: string | null, t: TranslateFn): string {
    if (mode === 'steps') return t('cowork_task.mode.steps', 'Fixed steps');
    if (mode === 'agent') return agentName ? t('cowork_task.how.agent_named', "Your agent '{agent}' does it", { agent: agentName }) : t('cowork_task.mode.agent', 'An agent of yours does it');
    return t('cowork_task.how.ai', 'The AI works it out every run');
}

const CHIP = `inline-flex items-center gap-1.5 min-h-9 pointer-coarse:min-h-11! px-3 rounded-lg border text-[13px] leading-5 font-medium ${TINT}`;

/**
 * What the fixed steps use, in one line, so the row never contradicts the Steps section; with a warning when a step
 * needs an app that is not among the owner's (the run would stop at that step). Null for a task without fixed steps.
 */
function stepAppsLine(stepApps: readonly StepApp[] | null, connected: ReadonlySet<string> | null, t: TranslateFn): { line: string; missing: boolean } | null {
    if (!stepApps) return null;
    if (stepApps.length === 0) return { line: t('cowork_task.uses.steps_none', 'Its fixed steps use no app.'), missing: false };
    const apps = stepApps.map((a) => a.label).join(', ');
    const missing = connected ? stepApps.filter((a) => !connected.has(a.id)).map((a) => a.label) : [];
    if (missing.length === 0) return { line: t('cowork_task.uses.steps_use', 'Its fixed steps use: {apps}.', { apps }), missing: false };
    return { line: t('cowork_task.uses.steps_missing', 'Its fixed steps use: {apps}. Not connected for you now: {missing}. The steps that need it stop until it is connected.', { apps, missing: missing.join(', ') }), missing: true };
}

/** The apps it may use: one chip each, pressed while it is on. */
function Apps({ draft, set, id, stepApps, t }: { draft: TaskDraft; set: Set; id: string; stepApps: readonly StepApp[] | null; t: TranslateFn }) {
    const { availableApps, isAppEnabled, toggleApp, appsKnown, appsUnavailable } = useCoworkApps({ value: draft.apps, onChange: (apps) => set({ apps }) });
    const apps = availableApps.filter((a) => !a.isStep);
    const used = stepAppsLine(draft.mode === 'steps' ? stepApps : null, appsKnown ? new Set(availableApps.map((a) => a.id)) : null, t);
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-task-apps">
            <span className={PART_H} id={`${id}-apps`}>{t('cowork_task.uses.apps', 'Apps it may use')}</span>
            {used && <p className={`m-0 text-[14px] leading-5 ${used.missing ? 'text-[var(--warning-ink)]' : 'text-[var(--text-primary)]'}`} data-testid="cowork-task-step-apps">{used.line}</p>}
            {apps.length > 0 && (
                <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`${id}-apps`}>
                    {apps.map((app) => (
                        <button key={app.id} type="button" aria-pressed={isAppEnabled(app.id)} onClick={() => toggleApp(app.id)} className={`${CHIP} ${isAppEnabled(app.id) ? CHOICE_ON : CHOICE_OFF}`}>
                            {app.label}
                        </button>
                    ))}
                </div>
            )}
            {appsUnavailable && <p className={META} role="status">{t('cowork_task.uses.apps_unavailable', 'Your apps could not be read just now, so none is offered. Try again in a moment.')}</p>}
            {appsKnown && apps.length === 0 && (
                <p className={META}>
                    {t('cowork_task.uses.no_apps', 'No app is connected yet.')}{' '}
                    <a className="underline underline-offset-2 text-[var(--text-primary)]" href={settingsPathForTab('integrations')}>{t('cowork_task.uses.connect', 'Connect an app')}</a>
                </p>
            )}
            <p className={META}>
                {draft.apps === null
                    ? t('cowork_task.uses.apps_default', 'It has no list of its own yet: it uses the apps that are on for you. Switch one off or on to give it its own list.')
                    : t('cowork_task.uses.apps_own', 'It only uses the apps that are on here.')}
            </p>
        </div>
    );
}

function HowItWorks({ draft, set, agents, mayPlan, id, t }: { draft: TaskDraft; set: Set; agents: CoworkAgent[]; mayPlan: boolean; id: string; t: TranslateFn }) {
    const tiers = useModelTiersQuery('automation').data ?? {};
    const modes = MODES.filter(([mode]) => (mode !== 'steps' || mayPlan || draft.mode === 'steps') && (mode !== 'agent' || agents.length > 0 || draft.mode === 'agent'));
    return (
        <fieldset className="flex flex-col gap-2 border-0 p-0 m-0 min-w-0">
            <legend className={`${PART_H} mb-2`}>{t('cowork_task.edit.how', 'How it works')}</legend>
            {modes.map(([mode, key, en, lineKey, lineEn]) => (
                <label key={mode} htmlFor={`${id}-mode-${mode}`} aria-label={t(key, en)} className={`grid grid-cols-[auto_1fr] gap-x-3 items-start rounded-[var(--radius-md)] border px-3 py-2.5 cursor-pointer ${TINT} ${draft.mode === mode ? CHOICE_ON : CHOICE_OFF}`}>
                    <input id={`${id}-mode-${mode}`} type="radio" name={`${id}-mode`} className="mt-1 w-4 h-4" checked={draft.mode === mode} onChange={() => set({ mode })} />
                    <span className="flex flex-col gap-0.5"><span className="text-[14px] leading-5 font-medium text-[var(--text-primary)]">{t(key, en)}</span><span className={META}>{t(lineKey, lineEn)}</span></span>
                </label>
            ))}
            {draft.mode !== 'agent' && <CoworkModelPicker tiers={tiers} value={draft.modelTier || 'auto'} onChange={modelTier => set({ modelTier })} t={t} />}
            {draft.mode === 'agent' && (
                <div className="flex flex-col gap-1">
                    <label htmlFor={`${id}-agent`} className={LABEL}>{t('cowork_task.edit.which_agent', 'Which agent')}</label>
                    <select id={`${id}-agent`} className={FIELD} value={draft.agentId} onChange={(e) => set({ agentId: e.target.value })}>
                        <option value="">{t('cowork_task.when.choose', 'Choose…')}</option>
                        {agents.map((a) => <option key={a.id} value={a.id}>{a.name || t('cowork_task.edit.untitled_agent', 'Untitled agent')}</option>)}
                    </select>
                </div>
            )}
        </fieldset>
    );
}

interface TaskSetUsesProps {
    form: SettingRowForm;
    /** The apps its fixed steps use; null for a task without fixed steps. */
    stepApps?: readonly StepApp[] | null;
    agents: CoworkAgent[];
    /** The organisation has automations: a task may get fixed steps. */
    mayPlan: boolean;
    /** Its spending limit in euros a month; null: none. */
    limit: number | null;
    locale: string;
    t: TranslateFn;
}

export default function TaskSetUses({ form, stepApps = null, agents, mayPlan, limit, locale, t }: TaskSetUsesProps) {
    const { draft, set, submit, bar } = useSettingRow('uses', form);
    const id = `cowork-task-uses-${form.itemId}`;
    return (
        <>
            <form className="flex flex-col gap-4" onSubmit={(e) => { void submit(e); }}>
                <Apps draft={draft} set={set} id={id} stepApps={stepApps} t={t} />
                <HowItWorks draft={draft} set={set} agents={agents} mayPlan={mayPlan} id={id} t={t} />
                <SaveBar state={bar} onCancel={form.onDone} t={t} />
            </form>
            <MemoryPart coworkId={form.itemId} t={t} />
            <SpendingPart coworkId={form.itemId} limit={limit} locale={locale} t={t} />
        </>
    );
}
