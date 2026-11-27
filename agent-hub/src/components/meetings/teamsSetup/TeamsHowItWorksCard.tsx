import { Workflow } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { useTeamsOrgOverview } from '@/api/queries/teamsSetup';
import { ALERT_INFO, CHIP, CHIP_SUCCESS } from '@/components/shared/adminUi';

/** The window the members overview asks for; the same key shares its cache. */
const OVERVIEW_DAYS = 7;

type Source = 'recording' | 'transcript';

/**
 * Beside a way: "In use" for the source the organisation chose, "Each member chooses"
 * on both while the organisation has no opinion, nothing while that is unknown.
 */
function SourceMark({ way, chosen }: { way: Source; chosen: Source | null | undefined }) {
    const { t } = useTranslation();
    if (chosen === undefined) return null;
    if (chosen === null) return <span className={CHIP}>{t('teams_setup.how.members_choose')}</span>;
    return chosen === way ? <span className={CHIP_SUCCESS}>{t('teams_setup.how.in_use')}</span> : null;
}

/**
 * How a Teams meeting becomes a note, and who turns speech into text, for the organisation
 * admin: Teams only records; the text then comes from one of two sources, and the card
 * marks the one the organisation chose (teams-notes-settings `source`, read from the
 * members overview):
 *   - Bee Flow transcribes the recording with its own transcription service, or
 *   - Bee Flow imports the transcript Teams made.
 * The other source is the way back when the chosen one is missing
 * (server: core/meetingNotes/teamsArtifactChoice.mts). The summary is always Bee Flow's.
 */
export default function TeamsHowItWorksCard() {
    const { t } = useTranslation();
    const overview = useTeamsOrgOverview(OVERVIEW_DAYS).data;
    const chosen = overview ? (overview.settings?.source ?? null) : undefined;
    const ways: Array<{ way: Source; title: string; text: string }> = [
        { way: 'recording', title: t('teams_setup.source.recording'), text: t('teams_setup.how.way_recording') },
        { way: 'transcript', title: t('teams_setup.source.transcript'), text: t('teams_setup.how.way_transcript') },
    ];
    return (
        <section
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-5 py-4"
            aria-labelledby="teams-how-title" data-testid="teams-how-it-works"
        >
            <h4 id="teams-how-title" className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                <Workflow className="w-4 h-4 text-[var(--accent-secondary)]" aria-hidden="true" />
                {t('teams_setup.how.title')}
            </h4>
            <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5 text-[12px] text-[var(--text-secondary)]">
                <li>
                    <span className="font-semibold text-[var(--text-primary)]">{t('teams_setup.how.record_title')}.</span> {t('teams_setup.how.record')}
                </li>
                <li>
                    <span className="font-semibold text-[var(--text-primary)]">{t('teams_setup.how.text_title')}.</span>
                    <ul className="mt-1.5 flex list-none flex-col gap-2 pl-0">
                        {ways.map(({ way, title, text }) => (
                            <li key={way} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2" data-way={way}>
                                <span className="flex flex-wrap items-center gap-2">
                                    <span className="font-semibold text-[var(--text-primary)]">{title}</span>
                                    <SourceMark way={way} chosen={chosen} />
                                </span>
                                <span className="mt-0.5 block">{text}</span>
                            </li>
                        ))}
                    </ul>
                </li>
                <li>
                    <span className="font-semibold text-[var(--text-primary)]">{t('teams_setup.how.summarise_title')}.</span> {t('teams_setup.how.summarise')}
                </li>
            </ol>
            <p className={`mt-3 ${ALERT_INFO}`} data-testid="teams-how-way-back">{t('teams_setup.how.way_back')}</p>
        </section>
    );
}
