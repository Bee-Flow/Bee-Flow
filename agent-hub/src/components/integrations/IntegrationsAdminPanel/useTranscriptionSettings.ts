// Meeting-transcription settings writers of the IntegrationsAdminPanel —
// the pyannoteAI speech-model and voiceprint persistence, moved verbatim
// from IntegrationsAdminPanel.jsx.
import type { AdminMessage, VoiceprintPatch } from './IntegrationsAdminPanel.types';
import { errorBody, RefusedError } from '@/api/mutate';
import { apiFetch, apiRequest } from '@/api/typedRequest';

interface UseTranscriptionSettingsParams {
    pyannoteTranscriptionModel: string;
    setPyannoteTranscriptionModel: (value: string) => void;
    setSavingPyannoteModel: (value: boolean) => void;
    voiceprintMatchingEnabled: boolean;
    setVoiceprintMatchingEnabled: (value: boolean) => void;
    pyannoteIdentifyThreshold: number;
    setPyannoteIdentifyThreshold: (value: number) => void;
    setSavingVoiceprint: (value: boolean) => void;
    setMessage: (value: AdminMessage | null) => void;
}

export default function useTranscriptionSettings({
    pyannoteTranscriptionModel, setPyannoteTranscriptionModel, setSavingPyannoteModel,
    voiceprintMatchingEnabled, setVoiceprintMatchingEnabled,
    pyannoteIdentifyThreshold, setPyannoteIdentifyThreshold, setSavingVoiceprint,
    setMessage,
}: UseTranscriptionSettingsParams) {
    // ── pyannoteAI speech model ──────────────────────────────────────────────
    const saveTranscriptionModel = async (model: string) => {
        const prev = pyannoteTranscriptionModel;
        setPyannoteTranscriptionModel(model);
        setSavingPyannoteModel(true);
        try {
            let res: Response | undefined;
            try {
                res = await apiRequest('POST /ai/config', { body: { pyannoteTranscriptionModel: model } });
            } catch (apiErr) {
                if (!(apiErr instanceof RefusedError)) throw apiErr;
                const err = errorBody(apiErr) ?? {};
                setPyannoteTranscriptionModel(prev);
                setMessage({ type: 'error', text: err.error || 'Failed to save the speech model' });
            }
            if (res) {
                setMessage({ type: 'success', text: model ? 'Speech model pinned' : 'Speech model set to automatic' });
            }
        } catch (_) {
            setPyannoteTranscriptionModel(prev);
            setMessage({ type: 'error', text: 'Failed to save the speech model' });
        }
        setSavingPyannoteModel(false);
        setTimeout(() => setMessage(null), 3000);
    };

    // ── Voiceprint speaker identification ────────────────────────────────────
    // Optimistic: the toggle should feel instant, and a failed write is
    // reported and rolled back rather than silently kept.
    const saveVoiceprintSettings = async (patch: VoiceprintPatch) => {
        const prev = { voiceprintMatchingEnabled, pyannoteIdentifyThreshold };
        if (patch.voiceprintMatchingEnabled !== undefined) setVoiceprintMatchingEnabled(patch.voiceprintMatchingEnabled);
        if (patch.pyannoteIdentifyThreshold !== undefined) setPyannoteIdentifyThreshold(patch.pyannoteIdentifyThreshold);
        setSavingVoiceprint(true);
        try {
            const res = await apiFetch('POST /ai/config', { body: patch });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setVoiceprintMatchingEnabled(prev.voiceprintMatchingEnabled);
                setPyannoteIdentifyThreshold(prev.pyannoteIdentifyThreshold);
                setMessage({ type: 'error', text: err.error || 'Failed to save speaker-identification settings' });
            }
        } catch (_) {
            setVoiceprintMatchingEnabled(prev.voiceprintMatchingEnabled);
            setPyannoteIdentifyThreshold(prev.pyannoteIdentifyThreshold);
            setMessage({ type: 'error', text: 'Failed to save speaker-identification settings' });
        }
        setSavingVoiceprint(false);
        setTimeout(() => setMessage(null), 3000);
    };

    return { saveTranscriptionModel, saveVoiceprintSettings };
}
