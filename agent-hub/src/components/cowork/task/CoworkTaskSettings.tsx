/**
 * "Settings" of an opened task (./CoworkTaskView.tsx): everything its owner can set about this one task, under the
 * four questions the confirmation of a new task asks. Each row ALWAYS shows where it stands in plain words, and opens
 * in place to change it; one row is open at a time (the caller holds which, so "Change something" can open What).
 *
 *   What      its name, its sentence, the target to track                       ./TaskSetWhat.tsx
 *   When      the schedule or what else starts it (pausing is in the header)    ./TaskSetWhen.tsx
 *   Uses      its apps, how it works, what it remembers, its spending limit     ./TaskSetUses.tsx
 *   Sends to  who receives it, the one "Ask me" choice, trust per recipient     ./TaskSetSendsTo.tsx
 *
 * There is no separate edit screen. A change that needs the steps made again says so before it is saved ("Save and
 * test"); a change that does not (a name, a time) is saved at once (./coworkTaskSettingsModel.ts).
 */
import { useMemo } from 'react';
import useCoworkApps from '../useCoworkApps';
import TaskSetSendsTo from './TaskSetSendsTo';
import { targetLine } from './TaskSetTarget';
import TaskSetUses, { howWords } from './TaskSetUses';
import TaskSetWhat from './TaskSetWhat';
import TaskSetWhen, { whenWords } from './TaskSetWhen';
import { limitWords } from './TaskSetKeeps';
import { askLevelOf, askNote, reachesOthers, recipientsOf, sendsValue } from './coworkTaskSendsModel';
import { draftOf, type SettingRowId } from './coworkTaskSettingsModel';
import { ROWS, Section, SettingRow } from './taskRows';
import { useCoworkGoal } from '@/api/coworkGoals';
import { useCoworkIndependence } from '@/api/coworkIndependence';
import { useCoworkStart } from '@/api/coworkStart';
import { useCoworkAgents } from '@/api/queries/coworkReads';
import type { PlanState } from '@/api/coworkPlan.types';
import type { CoworkItem } from '@/api/cowork.types';
import type { TaskMode } from './coworkTaskModel';
import type { SettingRowForm } from './useTaskSettingsSave';
import type { TranslateFn } from '@/hooks/useTranslation';

/** The apps it may use, by name: its own list, or the ones that are on for its owner. */
function useAppsWords(enabledApps: string[] | null | undefined, t: TranslateFn): string {
    const { availableApps, isAppEnabled, appsKnown } = useCoworkApps({ value: enabledApps ?? null });
    const names = availableApps.filter((a) => !a.isStep && isAppEnabled(a.id)).map((a) => a.label);
    if (names.length > 0) return names.join(', ');
    return appsKnown ? t('cowork_task.uses.none', 'No apps') : t('cowork_task.uses.unknown', 'Apps not read yet');
}

export interface CoworkTaskSettingsProps {
    item: CoworkItem;
    mode: TaskMode;
    plan: PlanState | undefined;
    /** The organisation has automations: a task may get fixed steps. */
    mayPlan: boolean;
    /** The row that is open, if one is. */
    open: SettingRowId | null;
    onOpen: (row: SettingRowId | null) => void;
    /** Make the steps again from the sentence and test them once ("Save and test"). */
    onRebuild: () => void;
    onOpenTask: (id: string) => void;
    /** A run, a test or the setting up of steps is on the go: nothing is saved now. */
    live: boolean;
    locale: string;
    t: TranslateFn;
}

/** What each closed row says. */
function useRowWords({ item, mode, plan, open, locale, t }: CoworkTaskSettingsProps) {
    const start = useCoworkStart(item.id, true).query.data;
    const goal = useCoworkGoal(item.id).query.data ?? null;
    // Read for the agent's name, and for the choice of one once Uses is open.
    const agents = useCoworkAgents(mode === 'agent' || open === 'uses');
    const level = askLevelOf(useCoworkIndependence(item.id, true).query.data);
    const apps = useAppsWords(item.enabledApps, t);
    const limit = typeof item.monthlyBudget === 'number' ? item.monthlyBudget : null;
    const hasApprovedSteps = mode === 'steps' && !!plan?.approved;
    const sends = { item, mode, plan };
    return {
        start, agents, limit, hasApprovedSteps,
        what: { value: item.prompt || t('cowork_task.what.empty', 'No sentence yet'), note: targetLine(goal, t) },
        when: { value: whenWords(item, start, t) },
        uses: {
            value: `${apps} · ${howWords(mode, agents.find((a) => a.id === item.agentId)?.name ?? null, t)}`,
            note: limit === null ? null : t('cowork_task.limit.note', 'Spending limit: {limit}', { limit: limitWords(limit, null, locale, t) }),
        },
        sends: { value: sendsValue(sends, t), note: askNote(level, hasApprovedSteps, t), recipients: recipientsOf(sends, t), othersReached: reachesOthers(sends) },
    };
}

export default function CoworkTaskSettings(props: CoworkTaskSettingsProps) {
    const { item, mode, mayPlan, open, onOpen, onRebuild, onOpenTask, live, locale, t } = props;
    const words = useRowWords(props);
    const initial = useMemo(() => draftOf(item, words.start, mode), [item, words.start, mode]);
    const form: SettingRowForm = { itemId: item.id, initial, onRebuild, onDone: () => onOpen(null), locked: live };
    const row = (id: SettingRowId) => ({ id, open: open === id, onToggle: onOpen, t });
    return (
        <Section id="cowork-task-settings-h" heading={t('cowork_task.set.heading', 'Settings')} testId="cowork-task-settings">
            <div className={ROWS}>
                <SettingRow {...row('what')} label={t('cowork_task.set.what', 'What')} {...words.what}>
                    <TaskSetWhat form={form} t={t} />
                </SettingRow>
                <SettingRow {...row('when')} label={t('cowork_task.edit.when', 'When')} {...words.when}>
                    <TaskSetWhen form={form} onOpenTask={onOpenTask} t={t} />
                </SettingRow>
                <SettingRow {...row('uses')} label={t('cowork_task.set.uses', 'Uses')} {...words.uses}>
                    <TaskSetUses form={form} agents={words.agents} mayPlan={mayPlan} limit={words.limit} locale={locale} t={t} />
                </SettingRow>
                <SettingRow {...row('sends')} label={t('cowork_task.set.sends', 'Sends to')} value={words.sends.value} note={words.sends.note}>
                    <TaskSetSendsTo coworkId={item.id} mode={mode} hasApprovedSteps={words.hasApprovedSteps} othersReached={words.sends.othersReached} recipients={words.sends.recipients} t={t} />
                </SettingRow>
            </div>
        </Section>
    );
}
