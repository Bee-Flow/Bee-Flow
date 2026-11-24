/**
 * Teamwork, from the Cowork user menu (opens in the right-side sheet): tasks of different people that work together.
 * Everyone keeps their own task and their own apps. The desks the reader is on are cards (./CoworkTeamworkDesks.tsx);
 * "Help me set this up" (./CoworkTeamworkSetup.tsx) turns one sentence into a proposal the reader changes before any
 * invitation is sent. `onOpenTask` opens one of the reader's own tasks.
 */
import { useMyDesks } from '@/api/coworkDesks';
import { useTranslation } from '@/hooks/useTranslation';
import CoworkTeamworkDesk from './CoworkTeamworkDesks';
import CoworkTeamworkSetup from './CoworkTeamworkSetup';
import { PanelShell, Problem } from './panelParts';

export function CoworkTeamworkPanel({ onClose, onOpenTask }: { onClose: () => void; onOpenTask: (taskId: string) => void }) {
    const { t } = useTranslation();
    const desks = useMyDesks();
    const list = desks.data ?? [];
    return (
        <PanelShell testId="cowork-teamwork-panel" title={t('cowork_panels.team.title', 'Teamwork')} meta={t('cowork_panels.team.meta', 'Tasks of different people that work together. Everyone keeps their own task and their own apps.')} onClose={onClose}>
            <Problem error={desks.error} fallback={t('cowork_panels.failed_try', 'That did not work. Try again.')} />
            {list.map((desk) => <CoworkTeamworkDesk key={desk.id} deskId={desk.id} name={desk.name} isOwner={desk.isOwner} onOpenTask={onOpenTask} />)}
            <CoworkTeamworkSetup another={list.length > 0} />
        </PanelShell>
    );
}
