/**
 * Settings, from the Cowork user menu (opens in the right-side sheet): only for the signed-in person. The daily
 * digest e-mail (GET/PUT /api/cowork/daily-mail) and "Notice what I ask again and again" (GET/PUT /api/cowork/habits),
 * which stays off until switched on and is disabled with a note while the organisation has turned it off.
 *
 * There is no notification preference for Cowork on the server yet (the notification preferences cover projects
 * only), so the switches for "when something needs you", "when a run fails" and "after every run" are left out.
 */
import { useCoworkHabits } from '@/api/coworkHabits';
import { useCoworkDailyMail, useCoworkNeedsYou } from '@/api/coworkNeedsYou';
import { useTranslation } from '@/hooks/useTranslation';
import { CARD, META, PanelSection, PanelShell, Problem, SwitchRow } from './panelParts';

const EXAMPLE_ROWS = 3;

/** What tomorrow's e-mail would hold right now: the list of what waits for the person. */
function DigestExample() {
    const { t } = useTranslation();
    const needs = useCoworkNeedsYou().data ?? [];
    return (
        <div className="flex flex-col gap-1 rounded-lg bg-[var(--bg-secondary)] p-3 text-[13px] text-[var(--text-primary)]" data-testid="cowork-digest-example">
            <span className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('cowork_panels.settings.digest_example', 'Example of tomorrow’s digest')}</span>
            <strong>{needs.length === 0
                ? t('cowork_panels.settings.digest_none', 'Nothing needs you right now.')
                : t('cowork_panels.settings.digest_count', '{n} things need you', { n: needs.length })}</strong>
            {needs.slice(0, EXAMPLE_ROWS).map((n) => <span key={`${n.kind}-${n.itemId}-${n.runId ?? ''}`} className={META}>{n.title}</span>)}
        </div>
    );
}

function DigestSection() {
    const { t } = useTranslation();
    const { query, save } = useCoworkDailyMail();
    const mail = query.data;
    const label = t('cowork_panels.settings.digest', 'Send me a daily digest e-mail');
    return (
        <PanelSection title={t('cowork_panels.settings.digest_heading', 'Daily digest')}>
            <div className={CARD}>
                <SwitchRow
                    id="cowork-panels-digest"
                    label={label}
                    sub={mail && !mail.available
                        ? t('cowork_panels.settings.digest_unavailable', 'This Bee Flow cannot send e-mail yet. Ask your administrator.')
                        : t('cowork_panels.settings.digest_sub', 'Every morning: what needs you.')}
                    checked={!!mail?.enabled}
                    disabled={!mail?.available || save.isPending}
                    onChange={(next) => save.mutate(next)}
                />
                {mail?.enabled && <DigestExample />}
                <Problem error={save.error} fallback={t('cowork_panels.failed', 'That did not save. Try again.')} />
            </div>
        </PanelSection>
    );
}

function HabitsSection() {
    const { t } = useTranslation();
    const { query, set } = useCoworkHabits();
    const state = query.data;
    const allowed = state?.allowed ?? false;
    return (
        <PanelSection title={t('cowork_panels.settings.notice_heading', 'Notices what you repeat')}>
            <div className={CARD}>
                <SwitchRow
                    id="cowork-panels-notice"
                    label={t('cowork_panels.settings.notice', 'Notice what I ask again and again')}
                    sub={!state || allowed
                        ? t('cowork_panels.settings.notice_sub', 'Off unless you turn it on. In chat you then get the offer to let it run as a task.')
                        : t('cowork_panels.settings.notice_forbidden', 'Your organisation has turned this off.')}
                    checked={allowed && !!state?.on}
                    disabled={!allowed || set.isPending}
                    onChange={(next) => set.mutate(next)}
                />
                <ul className={`m-0 flex list-disc flex-col gap-1 pl-5 ${META}`}>
                    <li>{t('cowork_panels.settings.notice_how_1', 'It keeps only which apps you used and on which weekday.')}</li>
                    <li>{t('cowork_panels.settings.notice_how_2', 'It never keeps your words or the answers.')}</li>
                    <li>{t('cowork_panels.settings.notice_how_3', 'It forgets after 8 weeks, and right away when you turn this off.')}</li>
                    <li>{t('cowork_panels.settings.notice_how_4', 'Nobody else sees it, not even an admin.')}</li>
                </ul>
                <Problem error={set.error} fallback={t('cowork_panels.failed', 'That did not save. Try again.')} />
            </div>
        </PanelSection>
    );
}

export function CoworkSettingsPanel({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    return (
        <PanelShell testId="cowork-settings-panel" title={t('cowork_panels.settings.title', 'Settings')} meta={t('cowork_panels.settings.meta', 'Only for you.')} onClose={onClose}>
            <DigestSection />
            <HabitsSection />
        </PanelShell>
    );
}
