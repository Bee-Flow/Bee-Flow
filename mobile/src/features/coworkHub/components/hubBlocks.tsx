/**
 * The Cowork hub as blocks for BlockList, in urgency order:
 *   1. What went wrong        — failed runs, first, with the error visible.
 *   2. What is happening now  — live runs, cancellable.
 *   3. What is coming up      — tasks and reminders due soon.
 *   4. Where everything lives — the destinations, as rows.
 * The two lists with no upper bound — the schedules and the live runs — are
 * one block per row; the capped sections are one block each.
 */

import React from 'react';

import type { ActiveRun } from '@/features/automations';
import { ScheduleRow } from '@/features/cowork';
import { cardRows, type Block } from '@/shared/patterns';
import { Section } from '@/shared/ui';

import { ApprovalsWaitingBanner } from './ApprovalsWaitingBanner';
import { AutomationsUnavailableBanner } from './AutomationsUnavailableBanner';
import { ComingUpSection } from './ComingUpSection';
import { EverythingElseSection } from './EverythingElseSection';
import { RunCardSection } from './RunCardSection';
import { RunningRow } from './RunningRow';
import type { CoworkHub } from '../hooks/useCoworkHub';

export interface HubActions {
    onStop: (runId: string) => void;
    onNewTask: () => void;
    onNewReminder: () => void;
}

const block = (key: string, gap: Block['gap'], render: Block['render']): Block => ({ key, gap, render });

function noticeBlocks(hub: CoworkHub): Block[] {
    const out: Block[] = [];
    if (hub.automations.isError) {
        out.push(
            block('automations-error', 'section', () => (
                <AutomationsUnavailableBanner
                    error={hub.automations.error}
                    onRetry={() => void hub.automations.refetch()}
                />
            )),
        );
    }
    const pending = hub.pendingApprovals.data?.length ?? 0;
    if (pending > 0) {
        out.push(block('approvals', 'section', () => <ApprovalsWaitingBanner count={pending} />));
    }
    return out;
}

function scheduleBlocks(hub: CoworkHub): Block[] {
    const schedules = hub.schedules.data ?? [];
    if (schedules.length === 0) return [];
    return [
        block('scheduled', 'section', () => (
            <Section
                title="Scheduled"
                subtitle="Work you handed over. It runs whether the app is open or not."
            >
                {null}
            </Section>
        )),
        // Plain rows under the section title, not a card — as the hub has
        // always drawn them.
        ...schedules.map((s) => block(`schedule:${s.id}`, 'inner', () => <ScheduleRow schedule={s} />)),
    ];
}

function runningBlocks(hub: CoworkHub, onStop: (runId: string) => void): Block[] {
    const active = hub.active.data ?? [];
    if (active.length === 0) return [];
    const row = (run: ActiveRun) => (
        <RunningRow run={run} title={hub.titleFor(run.automationId)} onStop={() => onStop(run.runId)} />
    );
    return [
        block('running', 'section', () => <Section title="Running now">{null}</Section>),
        ...cardRows({ key: 'running', rows: active, rowKey: (run) => run.runId, render: row }),
    ];
}

export function hubBlocks(hub: CoworkHub, actions: HubActions): Block[] {
    const recent = hub.recent.data ?? [];
    return [
        ...noticeBlocks(hub),
        ...scheduleBlocks(hub),
        ...(hub.needsYou.length > 0
            ? [
                  block('needs-you', 'section', () => (
                      <RunCardSection
                          title="Needs you"
                          subtitle="Runs that stopped, or are waiting on a decision"
                          runs={hub.needsYou}
                          titleFor={hub.titleFor}
                      />
                  )),
              ]
            : []),
        ...runningBlocks(hub, actions.onStop),
        block('coming-up', 'section', () => (
            <ComingUpSection
                upcoming={hub.upcoming}
                onNewTask={actions.onNewTask}
                onNewReminder={actions.onNewReminder}
            />
        )),
        block('everything-else', 'section', () => (
            <EverythingElseSection
                automationCount={hub.automations.data?.length}
                taskCount={
                    hub.tasks.data ? hub.tasks.data.tasks.length + (hub.reminders.data?.length ?? 0) : undefined
                }
            />
        )),
        ...(recent.length > 0
            ? [
                  block('recent', 'section', () => (
                      <RunCardSection title="Recent activity" runs={recent.slice(0, 6)} titleFor={hub.titleFor} />
                  )),
              ]
            : []),
    ];
}
