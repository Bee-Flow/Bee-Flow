/**
 * More ways to run — the web's RunFlowMenu (BuilderHeader.jsx) as a sheet:
 * Dry-run (the toolbar's Play), Run live (asked first: every step performs
 * its action), and, for an automation with more than one trigger, which trigger
 * the next run starts from. A form trigger with nothing saved to run on is
 * opened instead of run: a form runs when somebody fills it in.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { FlowDefinition } from '@/features/flow-editor/model';
import { useConfirm } from '@/shared/patterns';
import { ActionMenu, useToast, type ActionMenuItem } from '@/shared/ui';

import { bareFormEntry } from './runMenu';
import type { TestRuns } from './useTestRuns';

export function RunMenu({
    visible,
    onClose,
    runs,
    definition,
    onOpenStep,
}: {
    visible: boolean;
    onClose: () => void;
    runs: TestRuns;
    definition: FlowDefinition | null;
    onOpenStep: (stepId: string) => void;
}) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const runLive = async () => {
        const ok = await confirm({
            title: t('mobile.flow.run.live_title', 'Run this automation for real?'),
            message: t('mobile.flow.run.live_message', 'Every step performs its action — sending messages, writing data, and anything else in the flow.'),
            confirmLabel: t('mobile.flow.run.live_confirm', 'Run it'),
        });
        if (!ok) return;
        const form = bareFormEntry(definition, runs.from);
        if (form) {
            toast(t('mobile.flow.run.form_first', 'A form runs when someone fills it in — save sample answers on its trigger to run it from here.'));
            onOpenStep(form);
            return;
        }
        runs.runLive();
    };
    const items: ActionMenuItem[] = [
        {
            id: 'dry',
            label: t('automations.header.dry_run', 'Dry-run (preview)'),
            icon: 'Eye',
            accessibilityHint: t('mobile.flow.run.dry_hint', 'No real actions — safe preview'),
            disabled: runs.running,
            onPress: runs.dryRun,
        },
        {
            id: 'live',
            label: t('automations.header.run_live', 'Run live'),
            icon: 'Play',
            accessibilityHint: t('automations.header.run_live_hint', 'Executes every step for real'),
            disabled: runs.running,
            onPress: () => void runLive(),
        },
        ...runs.starts.map((start) => ({
            id: `from:${start.id ?? 'primary'}`,
            label: t('mobile.flow.run.start_from', 'Start from {name}', { name: start.label }),
            icon: 'LogIn' as const,
            selected: runs.from === start.id,
            onPress: () => runs.setFrom(start.id),
        })),
    ];
    return <ActionMenu visible={visible} onClose={onClose} title={t('automations.header.more_ways_to_run', 'More ways to run')} items={items} testID="run-menu" />;
}
