import { Captions, Copy } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import useCopyToClipboard from '@/hooks/useCopyToClipboard';
import { useTeamsOrgOverview } from '@/api/queries/teamsSetup';
import { ALERT_INFO, SECONDARY_BTN } from '@/components/shared/adminUi';

/** The window the members overview asks for; the same key shares its cache. */
const OVERVIEW_DAYS = 7;

/**
 * What a Teams administrator runs once, in Teams PowerShell, to let Bee Flow import Teams
 * transcripts: transcription allowed in the meeting policy, and the two transcript API
 * switches of the meeting settings (docs: integrations/teams-meeting-notes, "Teams settings").
 * Literal commands, the same in every language.
 */
export const TEAMS_TRANSCRIPT_COMMANDS = [
    'Set-CsTeamsMeetingPolicy -Identity Global -AllowTranscription $true',
    'Set-CsTeamsMeetingConfiguration -Identity Global -EnableGraphTranscriptAccess $true -EnableAttributedTranscripts $true',
].join('\n');

/**
 * For the organisation admin who wants the notes to come from the Teams transcript: the
 * four things that must be in place, the commands for the Teams administrator ready to
 * copy, and what changes for members (nothing). Open when the organisation chose the Teams
 * transcript as the source; otherwise folded away with a line that says where to choose it.
 */
export default function TeamsTranscriptSetupCard() {
    const { t } = useTranslation();
    const { copy, copied } = useCopyToClipboard();
    const overview = useTeamsOrgOverview(OVERVIEW_DAYS).data;
    const chosen = overview?.settings?.source === 'transcript';
    return (
        <details
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
            open={chosen} data-testid="teams-transcript-setup"
        >
            <summary className="flex cursor-pointer items-center gap-2 px-5 py-3 text-[13px] font-semibold text-[var(--text-primary)]">
                <Captions className="w-4 h-4 text-[var(--accent-secondary)]" aria-hidden="true" />
                {t('teams_setup.transcript.title')}
            </summary>
            <div className="flex flex-col gap-3 border-t border-[var(--border-subtle)] px-5 py-4">
                {overview && !chosen && <p className={ALERT_INFO} data-testid="teams-transcript-not-chosen">{t('teams_setup.transcript.not_chosen')}</p>}
                <p className="text-[12px] text-[var(--text-muted)]">{t('teams_setup.transcript.intro')}</p>
                <ol className="flex list-decimal flex-col gap-1 pl-5 text-[12px] text-[var(--text-secondary)]">
                    <li>{t('teams_setup.transcript.need_policy')}</li>
                    <li>{t('teams_setup.transcript.need_api')}</li>
                    <li>{t('teams_setup.transcript.need_speakers')}</li>
                    <li>{t('teams_setup.transcript.need_consent')}</li>
                </ol>
                <div>
                    <p className="text-[12px] font-semibold text-[var(--text-primary)]">{t('teams_setup.transcript.commands_title')}</p>
                    <pre className="mt-1 overflow-x-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-[11px] text-[var(--text-primary)]" data-testid="teams-transcript-commands">{TEAMS_TRANSCRIPT_COMMANDS}</pre>
                    <button type="button" onClick={() => { void copy(TEAMS_TRANSCRIPT_COMMANDS); }} className={`mt-2 ${SECONDARY_BTN}`}>
                        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                        {copied ? t('teams_setup.transcript.copied') : t('teams_setup.transcript.copy')}
                    </button>
                </div>
                <p className="text-[12px] text-[var(--text-secondary)]">{t('teams_setup.transcript.after')}</p>
                <p className="text-[12px] text-[var(--text-secondary)]">{t('teams_setup.transcript.members')}</p>
            </div>
        </details>
    );
}
