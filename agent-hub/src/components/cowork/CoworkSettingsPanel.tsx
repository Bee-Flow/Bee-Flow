/**
 * The owner's own Cowork settings, opened from the page's menu in the sheet (`kind: 'settings'` of
 * ./coworkSheetPanels.ts): the morning mail of what waits for them (GET/PUT /api/cowork/daily-mail; absent when the
 * instance cannot send mail) and "Notice what I ask again and again" (./CoworkHabitsSwitch.tsx; absent where the
 * organisation does not allow it).
 */
import Toggle from '../shared/Toggle';
import CoworkHabitsSwitch from './CoworkHabitsSwitch';
import CoworkSheetHeading from './CoworkSheetHeading';
import { useCoworkDailyMail } from '@/api/coworkNeedsYou';
import { useTranslation } from '@/hooks/useTranslation';

function DailyMailSwitch() {
    const { t } = useTranslation();
    const { query, save } = useCoworkDailyMail();
    if (!query.data?.available) return null;
    const label = t('cowork_home.settings.daily_mail', 'E-mail me what waits for me, every morning');
    return (
        <div className="flex items-center justify-between gap-3 min-h-11 text-[15px] text-[var(--text-primary)]" data-testid="cowork-daily-mail">
            <span>{label}</span>
            <span className="inline-flex items-center gap-2">
                {save.isError && <span role="alert" className="text-[13px] text-[var(--error-ink)]">{t('cowork_home.settings.not_saved', 'That did not save. Try again.')}</span>}
                <Toggle checked={query.data.enabled} disabled={save.isPending} onChange={(next) => save.mutate(next)} ariaLabel={label} />
            </span>
        </div>
    );
}

export default function CoworkSettingsPanel() {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-3" data-testid="cowork-settings-panel">
            <CoworkSheetHeading>{t('cowork_home.menu.settings', 'Settings')}</CoworkSheetHeading>
            <DailyMailSwitch />
            <CoworkHabitsSwitch />
        </div>
    );
}
