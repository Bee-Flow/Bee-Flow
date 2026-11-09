// The transcription engines an admin can make active, with what each needs
// before it works. The order is the order of the list in the Transcription section.

export interface TranscriptionEngine {
    id: string;
    name: string;
    badge: string;
    emoji: string;
    catalogId: string;
    desc: string;
    requires: string;
    ready: boolean;
}

interface Readiness {
    hasAzureSpeechKey: boolean;
    hasWhisperxUrl: boolean;
    hasScalewayKey: boolean;
    hasPyannoteKey: boolean;
}

export function transcriptionEngines({ hasAzureSpeechKey, hasWhisperxUrl, hasScalewayKey, hasPyannoteKey }: Readiness): TranscriptionEngine[] {
    return [
        {
            id: 'voxtral', name: 'Voxtral', badge: 'Mistral Cloud', emoji: '⚡', catalogId: 'integration.fast',
            desc: 'Fast, high-quality cloud transcription with built-in diarization. Requires a Mistral API key.',
            requires: 'Mistral API key (AI Config)',
            ready: true, // always potentially ready via API key
        },
        {
            id: 'azure', name: 'Azure Speech', badge: 'Microsoft Cloud', emoji: '☁️', catalogId: 'integration.cloud',
            desc: 'Enterprise-grade Whisper model on Azure. Great for compliance-conscious organisations.',
            requires: 'Azure Speech key + region',
            ready: hasAzureSpeechKey,
        },
        {
            id: 'whisper_azure', name: 'Azure Whisper', badge: 'Batch API', emoji: '🎙️', catalogId: 'integration.recording',
            desc: 'Higher accuracy via Azure Batch Transcription (Whisper model). Async — large files, up to 35 speakers. Uses RustFS for temp audio storage.',
            requires: 'Azure Speech key + RustFS',
            ready: hasAzureSpeechKey,
        },
        {
            id: 'whisperx', name: 'WhisperX', badge: 'Self-hosted', emoji: '🏠', catalogId: 'integration.local',
            desc: 'Fully private. Run Whisper on your own server — audio never leaves your infrastructure. For CPU-only voice capture (chat input, no GPU required), the in-process whisper.cpp path is used automatically.',
            requires: 'Self-hosted server URL (optional — CPU whisper.cpp runs without it)',
            ready: hasWhisperxUrl,
        },
        {
            id: 'scaleway', name: 'Scaleway (hybrid)', badge: 'Cloud + local', emoji: '🇪🇺', catalogId: 'integration.fast',
            desc: 'Fast GDPR-EU cloud transcription (Whisper large-v3) with speaker labels from your local WhisperX diarizer. Audio is sent to your Scaleway EU project.',
            requires: 'Scaleway API key' + (hasWhisperxUrl ? '' : ' + WhisperX URL (for speakers)'),
            ready: hasScalewayKey,
        },
        {
            id: 'pyannote', name: 'pyannoteAI', badge: 'Diarization + STT', emoji: '🎯', catalogId: 'integration.cloud',
            desc: 'Premium speaker diarization + speaker-attributed transcription (precision-3) in one call. Best-in-class multi-speaker separation. Audio is uploaded to pyannoteAI temporary storage (24h) — no self-hosted diarizer or RustFS/public URL needed.',
            requires: 'pyannoteAI API key',
            ready: hasPyannoteKey,
        },
    ];
}
