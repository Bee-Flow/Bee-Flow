// POST /ai/config with the meeting-transcription settings the admin section
// saves (provider choice, provider credentials). Hands the Response back
// untouched: the caller reads `res.ok` and the error body.
import { API_BASE, authFetch } from './mutate';

export function saveTranscriptionConfig(body: unknown): Promise<Response> {
    return authFetch(`${API_BASE}/ai/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
