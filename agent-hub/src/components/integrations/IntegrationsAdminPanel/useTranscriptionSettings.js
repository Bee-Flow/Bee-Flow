// Meeting-transcription settings writers of the IntegrationsAdminPanel —
// the pyannoteAI speech-model and voiceprint persistence, moved verbatim
// from IntegrationsAdminPanel.jsx.
import { API_BASE, authFetch } from '../../../utils/helpers';

export default function useTranscriptionSettings({
    pyannoteTranscriptionModel, setPyannoteTranscriptionModel, setSavingPyannoteModel,
    voiceprintMatchingEnabled, setVoiceprintMatchingEnabled,
    pyannoteIdentifyThreshold, setPyannoteIdentifyThreshold, setSavingVoiceprint,
    setMessage,
}) {
    // ── pyannoteAI speech model ──────────────────────────────────────────────
    const saveTranscriptionModel = async (model) => {
        const prev = pyannoteTranscriptionModel;
        setPyannoteTranscriptionModel(model);
        setSavingPyannoteModel(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pyannoteTranscriptionModel: model }),
            });
            if (res.ok) {
                setMessage({ type: 'success', text: model ? 'Speech model pinned' : 'Speech model set to automatic' });
            } else {
                const err = await res.json().catch(() => ({}));
                setPyannoteTranscriptionModel(prev);
                setMessage({ type: 'error', text: err.error || 'Failed to save the speech model' });
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
    const saveVoiceprintSettings = async (patch) => {
        const prev = { voiceprintMatchingEnabled, pyannoteIdentifyThreshold };
        if (patch.voiceprintMatchingEnabled !== undefined) setVoiceprintMatchingEnabled(patch.voiceprintMatchingEnabled);
        if (patch.pyannoteIdentifyThreshold !== undefined) setPyannoteIdentifyThreshold(patch.pyannoteIdentifyThreshold);
        setSavingVoiceprint(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
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
