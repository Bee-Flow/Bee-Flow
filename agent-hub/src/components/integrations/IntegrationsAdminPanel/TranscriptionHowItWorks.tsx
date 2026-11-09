import { useTranslation } from '@/hooks/useTranslation';
import { SettingsGroup } from '@/components/shared/SettingsList';

const STEPS = [
    { step: '1', title: 'Upload audio', desc: 'In Meeting Notes, attach an audio file (MP3, WAV, M4A, WEBM, OGG, FLAC) to a message and say "Transcribe this".' },
    { step: '2', title: 'Provider transcribes', desc: 'The active provider converts speech to text and returns timed segments with a generic speaker ID per segment (e.g. SPEAKER_00, Guest).' },
    { step: '3', title: 'Speaker names identified', desc: 'The AI analyses the transcript context and maps generic speaker IDs to real names if they are mentioned in the conversation.' },
    { step: '4', title: 'Result returned', desc: 'A formatted transcript with timestamps and speaker names is returned in the chat and can be exported or summarised.' },
];

/** The four steps from an uploaded recording to a transcript. */
export default function TranscriptionHowItWorks() {
    const { t } = useTranslation();
    return (
        <SettingsGroup title={t('integ.transcription_how_transcription_works', 'How Transcription Works')}>
            <ol className="m-0 flex list-none flex-col gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
                {STEPS.map(item => (
                    <li key={item.step} className="flex gap-3">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--bg-tertiary)] text-[11px] font-semibold text-[var(--text-secondary)]">{item.step}</span>
                        <div>
                            <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">{item.title}</p>
                            <p className="m-0 text-xs text-[var(--text-tertiary)]">{item.desc}</p>
                        </div>
                    </li>
                ))}
            </ol>
        </SettingsGroup>
    );
}
