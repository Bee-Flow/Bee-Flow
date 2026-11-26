/**
 * Cowork preferences, the page behind the gear of the Cowork home: what holds for the signed-in person only. The
 * morning e-mail with what needs them (GET/PUT /api/cowork/daily-mail) and "Suggest a task when I repeat a question"
 * (GET/PUT /api/cowork/habits), which stays off until switched on and is disabled with a note while the organisation
 * has turned it off. Each switch saves at once.
 *
 * There is no notification preference for Cowork on the server yet (the notification preferences cover projects
 * only), so the switches for "when something needs you", "when a run fails" and "after every run" are left out.
 */
import { useCoworkHabits } from '@/api/coworkHabits';
import { useCoworkDailyMail, useCoworkNeedsYou } from '@/api/coworkNeedsYou';
import { useTranslation } from '@/hooks/useTranslation';
import { ENTER } from '../coworkMotion';
import { CARD_INSET } from '../coworkUi';
import { CARD, EYEBROW, META, PanelSection, PanelShell, Problem, SwitchRow } from './panelParts';

const EXAMPLE_ROWS = 3;

/** What tomorrow's e-mail would hold right now: the list of what waits for the person. */
function MorningExample() {
    const { t } = useTranslation();
    const needs = useCoworkNeedsYou().data ?? [];
    return (
        <div className={`${CARD_INSET} ${ENTER} flex flex-col gap-1 p-3 text-[14px] leading-5 text-[var(--text-primary)]`} data-testid="cowork-digest-example">
            <span className={EYEBROW}>{t('cowork_panels.settings.morning_example', 'What tomorrow’s e-mail would say now')}</span>
            <span className="font-semibold">{needs.length === 0
                ? t('cowork_panels.settings.digest_none', 'Nothing needs you right now.')
                : t('cowork_panels.settings.digest_count', '{n} things need you', { n: needs.length })}</span>
            {needs.slice(0, EXAMPLE_ROWS).map((n) => <span key={`${n.kind}-${n.itemId}-${n.runId ?? ''}`} className={META}>{n.title}</span>)}
        </div>
    );
}

function MorningSection() {
    const { t } = useTranslation();
    const { query, save } = useCoworkDailyMail();
    const mail = query.data;
    return (
        <PanelSection section="mail" title={t('cowork_panels.settings.morning_heading', 'E-mail')}>
            <div className={CARD}>
                <SwitchRow
                    id="cowork-panels-digest"
                    label={t('cowork_panels.settings.morning_mail', 'E-mail me each morning what needs me')}
                    sub={mail && !mail.available ? t('cowork_panels.settings.digest_unavailable', 'This Bee Flow cannot send e-mail yet. Ask your administrator.') : undefined}
                    checked={!!mail?.enabled}
                    disabled={!mail?.available || save.isPending}
                    onChange={(next) => save.mutate(next)}
                />
                {mail?.enabled && <MorningExample />}
                <Problem error={save.error} fallback={t('cowork_panels.failed', 'That did not save. Try again.')} />
            </div>
        </PanelSection>
    );
}

function SuggestSection() {
    const { t } = useTranslation();
    const { query, set } = useCoworkHabits();
    const state = query.data;
    const allowed = state?.allowed ?? false;
    return (
        <PanelSection section="suggestions" title={t('cowork_panels.settings.suggest_heading', 'Suggestions')}>
            <div className={CARD}>
                <SwitchRow
                    id="cowork-panels-notice"
                    label={t('cowork_panels.settings.suggest', 'Suggest a task when I repeat a question')}
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

export default function CoworkSettingsPanel() {
    const { t } = useTranslation();
    return (
        <PanelShell testId="cowork-settings-panel" title={t('cowork_panels.settings.prefs_title', 'Cowork preferences')} meta={t('cowork_panels.settings.meta', 'Only for you.')}>
            <MorningSection />
            <SuggestSection />
        </PanelShell>
    );
}
