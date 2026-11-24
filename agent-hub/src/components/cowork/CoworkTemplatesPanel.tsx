/**
 * Templates, opened from the page's menu or "Start from a template" under the composer, in the sheet
 * (`kind: 'templates'` of ./coworkSheetPanels.ts): the organisation's templates and adding one from a file
 * (./CoworkTemplates.tsx). A task added from one opens in the same sheet.
 */
import CoworkSheetHeading from './CoworkSheetHeading';
import CoworkTemplates from './CoworkTemplates';
import type { CoworkSheetPanelProps } from './coworkSheetPanels';
import { useTranslation } from '@/hooks/useTranslation';

export default function CoworkTemplatesPanel({ open, close }: CoworkSheetPanelProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col" data-testid="cowork-templates-panel">
            <CoworkSheetHeading>{t('cowork_home.menu.templates', 'Templates')}</CoworkSheetHeading>
            <CoworkTemplates startOpen onClose={close} onAdded={(id) => open({ kind: 'task', id })} />
        </div>
    );
}
