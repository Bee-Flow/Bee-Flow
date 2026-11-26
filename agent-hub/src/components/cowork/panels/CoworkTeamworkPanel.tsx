/**
 * Teamwork, a page of Cowork (the home's Teamwork row opens it): tasks of different people that work together.
 * Everyone keeps their own task and their own apps. The desks the reader is on are cards (./CoworkTeamworkDesks.tsx);
 * "Send each result to a colleague's task" (./CoworkTeamworkSetup.tsx) turns one sentence into a proposal the reader
 * changes before any invitation is sent. `onOpenTask` opens one of the reader's own tasks as its page.
 */
import { useContext, useState } from 'react';
import { GuidedPanelContext } from './panelGuidance';
import { useMyDesks } from '@/api/coworkDesks';
import { useTranslation } from '@/hooks/useTranslation';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';
import CoworkTeamworkDesk from './CoworkTeamworkDesks';
import CoworkTeamworkSetup from './CoworkTeamworkSetup';
import { PanelButton, PanelLayout, PanelLoading, PanelReadProblem } from './panelParts';

import GuidedTeamwork from './GuidedTeamwork';

const browseDesks = {mode: 'browse' as const, message: ''};

export default function CoworkTeamworkPanel({ open, panel }: CoworkSheetPanelProps) {
    const onOpenTask = (id: string) => open({ kind: 'task', id });
    const { t } = useTranslation();
    const guided = useContext(GuidedPanelContext);
    const desks = useMyDesks();
    const list = desks.data ?? [];
    const request = panel.kind === 'teamwork' ? panel.request : undefined;
    const initial = request ?? browseDesks;
    const [expandedFor, setExpandedFor] = useState<typeof initial | null>(null);
    const canSwitch = guided || !!request;
    const expanded = expandedFor === initial;
    const action = canSwitch && <PanelButton look="inline" onClick={() => setExpandedFor(expanded ? null : initial)}>
        {expanded ? t('cowork_task.orb.back', 'Back to the orb') : t('cowork_overview.advanced', 'Advanced')}
    </PanelButton>;
    if (canSwitch && !expanded) return <GuidedTeamwork initial={initial} onOpenTask={onOpenTask} action={action} />;
    return (
        <PanelLayout testId="cowork-teamwork-panel" title={t('cowork_panels.team.title', 'Teamwork')} meta={t('cowork_panels.team.meta', 'Tasks of different people that work together. Everyone keeps their own task and their own apps.')} action={action}>
            <PanelReadProblem error={desks.error} retry={() => void desks.refetch()} />
            {desks.isPending && <PanelLoading />}
            {list.map((desk) => <CoworkTeamworkDesk key={desk.id} deskId={desk.id} name={desk.name} isOwner={desk.isOwner} onOpenTask={onOpenTask} />)}
            <CoworkTeamworkSetup another={list.length > 0} />
        </PanelLayout>
    );
}
