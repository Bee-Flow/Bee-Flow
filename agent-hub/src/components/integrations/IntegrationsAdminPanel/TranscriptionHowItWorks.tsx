import { useTranslation } from '@/hooks/useTranslation';

/** The four steps from an uploaded recording to a transcript. */
export default function TranscriptionHowItWorks() {
    const { t } = useTranslation();
    return (
        <div className="rounded-2xl border overflow-hidden bg-[var(--bg-secondary)] border-[var(--border-default)]">
            <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
                <h3 className="font-semibold text-[var(--text-primary)]">{t('integ.transcription_how_transcription_works', 'How Transcription Works')}</h3>
            </div>
            <div className="p-6">
                <ol className="space-y-3">
                    {[
                        { step: '1', title: 'Upload audio', desc: 'In Meeting Notes, attach an audio file (MP3, WAV, M4A, WEBM, OGG, FLAC) to a message and say "Transcribe this".' },
                        { step: '2', title: 'Provider transcribes', desc: 'The active provider converts speech to text and returns timed segments with a generic speaker ID per segment (e.g. SPEAKER_00, Guest).' },
                        { step: '3', title: 'Speaker names identified', desc: 'The AI analyses the transcript context and maps generic speaker IDs to real names if they are mentioned in the conversation.' },
                        { step: '4', title: 'Result returned', desc: 'A formatted transcript with timestamps and speaker names is returned in the chat and can be exported or summarised.' },
                    ].map(item => (
                        <li key={item.step} className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center [background:var(--accent-primary)] [color:#fff]!">{item.step}</span>
                            <div>
                                <p className="text-sm font-medium text-[var(--text-primary)]">{item.title}</p>
                                <p className="text-xs text-[var(--text-muted)]">{item.desc}</p>
                            </div>
                        </li>
                    ))}
                </ol>
            </div>
        </div>
    );
}
