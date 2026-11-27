import { Workflow } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { ALERT_INFO } from '@/components/shared/adminUi';

/**
 * How a Teams meeting becomes a note, and who turns speech into text, for the organisation
 * admin: Teams only records; Bee Flow transcribes the recording with its own transcription
 * service and writes the summary with the organisation's own models. The one exception is
 * said apart: a meeting that was transcribed in Teams but not recorded is imported from the
 * text Microsoft made (core/meetingNotes/ingestTeamsRecording.js: recording preferred,
 * transcript as fallback).
 */
export default function TeamsHowItWorksCard() {
    const { t } = useTranslation();
    const steps = [
        { title: t('teams_setup.how.record_title'), text: t('teams_setup.how.record') },
        { title: t('teams_setup.how.transcribe_title'), text: t('teams_setup.how.transcribe') },
        { title: t('teams_setup.how.summarise_title'), text: t('teams_setup.how.summarise') },
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
                {steps.map((step) => (
                    <li key={step.title}>
                        <span className="font-semibold text-[var(--text-primary)]">{step.title}.</span> {step.text}
                    </li>
                ))}
            </ol>
            <p className={`mt-3 ${ALERT_INFO}`} data-testid="teams-how-fallback">
                <span>
                    <span className="font-semibold text-[var(--text-primary)]">{t('teams_setup.how.fallback_title')}.</span> {t('teams_setup.how.fallback')}
                </span>
            </p>
        </section>
    );
}
