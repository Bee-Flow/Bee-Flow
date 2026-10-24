import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { isAbortError, messageOf } from '../../../utils/caughtError';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { VOICE_STATES } from './voiceSessionAudio';
import type {
    ConnectOptions,
    UseVoiceSessionArgs,
    VoiceEventData,
    VoiceHistoryMessage,
    VoiceLatency,
    VoiceSessionInfo,
    VoiceState,
    VoiceTool,
} from './useVoiceSession.types';
import { logger } from '../../../utils/logger';

/** What one voice turn reads and writes: the hook's refs, setters and TTS player. */
export interface VoiceTurnCtx {
    sessionRef: MutableRefObject<VoiceSessionInfo | null>;
    getHistoryRef: MutableRefObject<UseVoiceSessionArgs['getHistory']>;
    onTurnCompleteRef: MutableRefObject<UseVoiceSessionArgs['onTurnComplete']>;
    stickyLanguageRef: MutableRefObject<string | null>;
    abortRef: MutableRefObject<AbortController | null>;
    voiceActiveRef: MutableRefObject<boolean>;
    setPartialReply: Dispatch<SetStateAction<string>>;
    setPartialTranscript: Dispatch<SetStateAction<string>>;
    setTurnTools: Dispatch<SetStateAction<VoiceTool[]>>;
    setNotice: Dispatch<SetStateAction<string | null>>;
    setError: Dispatch<SetStateAction<string | null>>;
    setLatency: Dispatch<SetStateAction<VoiceLatency | null>>;
    setStateSync: (next: VoiceState) => void;
    playTts: (b64: string, mime: string) => void;
}

/** What the SSE events of one turn accumulate. */
interface TurnState {
    userText: string;
    assistantText: string;
    ttsPlayed: boolean;
    tools: VoiceTool[];
    metrics: { sttMs: number | null; ttftMs: number | null; ttsMs: number | null };
    startedAt: number;
}

function buildTurnForm(ctx: VoiceTurnCtx, blob: Blob, mimeType: string): FormData {
    // Ref, not state: finishRecording (and the VAD interval behind it) hold
    // a render-1 closure forever, so the state variable would be pinned
    // to its initial null. See sessionRef in the hook.
    const activeSession = ctx.sessionRef.current;

    const hostHistory = (ctx.getHistoryRef.current?.() || [])
        .filter((m: VoiceHistoryMessage) => m && m.role && typeof m.content === 'string')
        .filter((m: VoiceHistoryMessage) => !m.isHidden && !m.isStreaming)
        .map(({ role, content }: VoiceHistoryMessage) => ({ role, content }));

    const form = new FormData();
    const ext = (mimeType.split('/')[1] || 'webm').split(';')[0];
    form.append('audio', blob, `turn.${ext}`);
    form.append('history', JSON.stringify(hostHistory));
    if (activeSession?.model) form.append('model', activeSession.model);
    if (activeSession?.voice) form.append('voice', activeSession.voice);
    // Language precedence: sticky (first confirmed) > session override > auto-detect.
    const langHint = ctx.stickyLanguageRef.current || activeSession?.language || null;
    if (langHint) form.append('language', langHint);
    if (activeSession?.systemPrompt) form.append('systemPrompt', activeSession.systemPrompt);
    if (activeSession?.agentId) form.append('agentId', activeSession.agentId);
    return form;
}

function upsertTool(ctx: VoiceTurnCtx, st: TurnState, id: string, patch: Partial<VoiceTool>): void {
    const idx = st.tools.findIndex((t: VoiceTool) => t.id === id);
    if (idx === -1) st.tools.push({ id, ...patch });
    else st.tools[idx] = { ...st.tools[idx], ...patch };
    ctx.setTurnTools([...st.tools]);
}

function onTranscript(ctx: VoiceTurnCtx, st: TurnState, data: VoiceEventData): void {
    st.userText = data.text || '';
    st.metrics.sttMs = data.latencyMs ?? null;
    ctx.setPartialTranscript(st.userText);
    // Lock language on first non-empty transcription so future
    // turns don't flip between Dutch / Italian / etc. on short
    // utterances. Only promote to sticky on substantial text.
    if (!ctx.stickyLanguageRef.current && data.language && st.userText.length >= 8) {
        ctx.stickyLanguageRef.current = String(data.language).toLowerCase().slice(0, 2);
    }
}

function onTtsUnavailable(ctx: VoiceTurnCtx, data: VoiceEventData): void {
    if (data.reason === 'no_voice_configured') {
        ctx.setNotice('Voxtral TTS needs a voice to speak with. Create one via POST /v1/audio/voices on api.mistral.ai, or add an ElevenLabs API key as a fallback. Showing transcript only for now.');
    } else if (data.reason === 'tts_failed') {
        ctx.setNotice('Voice synthesis failed — showing transcript only. Check server logs for details.');
    } else {
        ctx.setNotice('No text-to-speech provider is configured. Add a Voxtral voice on api.mistral.ai or an ElevenLabs API key in Admin → AI Config.');
    }
}

function onTurnDone(ctx: VoiceTurnCtx, st: TurnState, data: VoiceEventData): void {
    if (st.userText && ctx.onTurnCompleteRef.current) {
        const frozenTools = st.tools.map((t: VoiceTool) => ({ ...t }));
        // Prefer the server-cleaned text (JSON/code fragments
        // stripped) over the raw streaming buffer so the chat
        // bubble matches what TTS actually said.
        const finalAssistant = (typeof data.assistantText === 'string' && data.assistantText.trim())
            ? data.assistantText
            : st.assistantText;
        ctx.onTurnCompleteRef.current({
            user: { role: 'user', content: st.userText, source: 'voice' },
            assistant: finalAssistant || frozenTools.length
                ? { role: 'assistant', content: finalAssistant, source: 'voice', tools: frozenTools }
                : null,
        });
    }
    ctx.setPartialTranscript('');
    ctx.setPartialReply('');
    ctx.setTurnTools([]);
    ctx.setLatency({ ...st.metrics, totalMs: Date.now() - st.startedAt });
    if (!st.ttsPlayed && ctx.voiceActiveRef.current) ctx.setStateSync(VOICE_STATES.IDLE);
}

function dispatchTurnEvent(ctx: VoiceTurnCtx, st: TurnState, event: string, dataRaw: string): void {
    let data: VoiceEventData = {};
    try { data = JSON.parse(dataRaw); } catch (err) { logger.debug('ignore', err); }
    switch (event) {
        case 'transcript':
            onTranscript(ctx, st, data);
            break;
        case 'no_speech':
            break;
        case 'text':
            if (data.delta) {
                st.assistantText += data.delta;
                ctx.setPartialReply(st.assistantText);
            }
            break;
        case 'tool_use':
            upsertTool(ctx, st, data.id as string, { name: data.name, input: data.input, status: 'running', round: data.round ?? 0 });
            break;
        case 'tool_result':
            upsertTool(ctx, st, data.id as string, { name: data.name, status: data.ok ? 'done' : 'error', summary: data.summary || (data.ok ? 'ok' : 'failed') });
            break;
        case 'llm_done':
            if (Array.isArray(data.rounds) && data.rounds.length > 0) {
                st.metrics.ttftMs = data.rounds[0]?.ttftMs ?? null;
            }
            break;
        case 'tts':
            st.metrics.ttsMs = data.latencyMs ?? null;
            if (data.audioBase64) {
                ctx.playTts(data.audioBase64, data.mimeType || 'audio/mpeg');
                st.ttsPlayed = true;
            }
            break;
        case 'tts_unavailable':
            onTtsUnavailable(ctx, data);
            break;
        case 'error':
            ctx.setError(data.message || 'Voice turn failed');
            ctx.setStateSync(VOICE_STATES.ERROR);
            break;
        case 'done':
            onTurnDone(ctx, st, data);
            break;
        default:
            break;
    }
}

/** Split one SSE frame into its event name and joined data lines (null without data). */
function parseFrame(frame: string): { event: string; data: string } | null {
    const lines = frame.split('\n');
    let event = 'message';
    const dataLines = [];
    for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    return dataLines.length ? { event, data: dataLines.join('\n') } : null;
}

/** Read the SSE body of a turn to its end, dispatching each frame as it completes. */
async function readTurnStream(ctx: VoiceTurnCtx, st: TurnState, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const parsed = parseFrame(frame);
            if (parsed) dispatchTurnEvent(ctx, st, parsed.event, parsed.data);
        }
    }
}

/** POST the recorded utterance to /ai/voice/turn and play the streamed answer. */
export async function streamVoiceTurn(ctx: VoiceTurnCtx, blob: Blob, mimeType: string): Promise<void> {
    ctx.setPartialReply('');
    const form = buildTurnForm(ctx, blob, mimeType);

    const controller = new AbortController();
    ctx.abortRef.current = controller;
    const startedAt = Date.now();

    let resp;
    try {
        resp = await authFetch(`${API_BASE}/ai/voice/turn`, {
            method: 'POST',
            body: form,
            signal: controller.signal,
        });
    } catch (err) {
        if (isAbortError(err)) {
            if (ctx.voiceActiveRef.current) ctx.setStateSync(VOICE_STATES.IDLE);
            return;
        }
        ctx.setError(messageOf(err, 'Network error'));
        ctx.setStateSync(VOICE_STATES.ERROR);
        return;
    }

    if (!resp.ok || !resp.body) {
        const j = await resp.json().catch(() => ({}));
        ctx.setError(j.message || j.error || `Voice turn failed (${resp.status})`);
        ctx.setStateSync(VOICE_STATES.ERROR);
        return;
    }

    const st: TurnState = {
        userText: '',
        assistantText: '',
        ttsPlayed: false,
        tools: [],
        metrics: { sttMs: null, ttftMs: null, ttsMs: null },
        startedAt,
    };
    await readTurnStream(ctx, st, resp.body);
}

/** POST /ai/voice/session; resolves to the session info, rejects with the server's message. */
export async function fetchVoiceSession(opts: ConnectOptions): Promise<VoiceSessionInfo> {
    const resp = await authFetch(`${API_BASE}/ai/voice/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            agentId: opts.agentId || null,
            voice: opts.voice || null,
            language: opts.language || null,
        }),
    });
    if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.message || j.error || `Failed to start voice session (${resp.status})`);
    }
    return resp.json();
}
