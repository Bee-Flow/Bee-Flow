/**
 * Teamwork, opened from the page's menu or the home's Teamwork section in the sheet (`kind: 'teamwork'` of
 * ./coworkSheetPanels.ts): the desks the owner is on, each opening to its tasks in the order work moves along them,
 * or setting one up with the helper (./CoworkDesks.tsx). A task of the owner's own opens in the same sheet.
 */
import CoworkDesks from './CoworkDesks';
import CoworkSheetHeading from './CoworkSheetHeading';
import type { CoworkSheetPanelProps } from './coworkSheetPanels';
import { useTranslation } from '@/hooks/useTranslation';

export default function CoworkTeamworkPanel({ open }: CoworkSheetPanelProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col -mx-[18px]" data-testid="cowork-teamwork-panel">
            <div className="px-[18px]"><CoworkSheetHeading>{t('cowork_home.menu.teamwork', 'Teamwork')}</CoworkSheetHeading></div>
            <CoworkDesks onOpen={(id) => open({ kind: 'task', id })} />
        </div>
    );
}
