/**
 * Whisper large-v3-turbo on the AMD XDNA2 NPU, via FastFlowLM.
 *
 * WHY THIS EXISTS: the local transcription path used to be Whisper-BASE running
 * in-process on the CPU through Transformers.js/WASM (see localWhisper.js). On
 * the Strix Halo box FastFlowLM serves Whisper large-v3-turbo on the NPU behind
 * an OpenAI-compatible endpoint, which is both a much better model and far
 * faster — measured 2.3 s for an 11 s clip and 9.5 s for a 66 s clip (~7x
 * realtime). The decisive property is WHERE it runs: transcription sits on the
 * NPU, so GPU load stays at ~1% and the chat model keeps the whole GPU. CPU
 * transcription competed with everything else on the box; this does not.
 *
 * THE ENDPOINT'S REAL CONTRACT (probed, not assumed):
 *   POST {base}/v1/audio/transcriptions   multipart: file, model, [language]
 *   ->   {"model":"whisper-v3","text":" ..."}
 * That is all. `response_format=verbose_json` is accepted and IGNORED — there
 * are NO segments, NO word timestamps and NO diarisation, ever. So this module
 * derives its own segment boundaries: it decodes once to 16 kHz mono PCM,
 * splits on the quietest point near each window boundary, and transcribes each
 * window separately. The offsets that produces are REAL (they come from sample
 * counts), just coarse — which is honest, unlike interpolating fake timings
 * across one blob of text.
 *
 * Diarisation is out of scope here exactly as it was for the CPU path: every
 * segment is `speaker_0`. Multi-speaker meetings still want a cloud provider
 * (Voxtral / WhisperX / pyannote).
 *
 * Fail-open: every failure returns null so `transcribeLocally` can fall back to
 * the in-process CPU model, and the caller keeps its existing error affordance.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');

// The server runs in Docker; the NPU service is a host systemd unit
// (flm-npu.service), so the default reaches back out to the host.
const DEFAULT_URL = 'http://host.docker.internal:52625';
const DEFAULT_MODEL = 'whisper-v3';

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;               // s16le mono
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;

// Window length for one NPU request. Each window becomes one segment, so this
// trades segment granularity against request overhead.
const WINDOW_SEC = Number(process.env.NPU_WHISPER_WINDOW_SEC) || 60;
// How far from an exact window boundary we may move the cut to land on silence.
const CUT_SEARCH_SEC = Number(process.env.NPU_WHISPER_CUT_SEARCH_SEC) || 8;
const MAX_DURATION_SEC = Number(process.env.NPU_WHISPER_MAX_DURATION_SEC) || 7200; // 2 h
// A trailing window shorter than this is merged into the previous one.
const MIN_TAIL_SEC = Number(process.env.NPU_WHISPER_MIN_TAIL_SEC) || 5;
// Chunks quieter than this are never sent. Digital silence is 0; a quiet
// speaker still runs well above 100, so this only catches genuine silence.
const SILENCE_RMS = Number(process.env.NPU_WHISPER_SILENCE_RMS) || 25;
const REQUEST_TIMEOUT_MS = Number(process.env.NPU_WHISPER_TIMEOUT_MS) || 300_000;
const PROBE_TIMEOUT_MS = 2000;

// BCP-47 -> the 2-letter code the endpoint expects. Anything unknown is sent
// as nothing at all, which makes Whisper auto-detect (verified working).
const LANG_CODES = new Set(['en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'tr', 'ja', 'zh', 'ko', 'ar', 'ru', 'sv', 'da', 'no', 'fi', 'cs', 'el', 'he', 'hi', 'id', 'uk', 'ro', 'hu']);

async function getSettings() {
    const enabled = (await configStore.getConfig('npu_whisper_enabled')) !== false;
    const url = (await configStore.getConfig('npu_whisper_url')) || process.env.NPU_WHISPER_URL || DEFAULT_URL;
    const model = (await configStore.getConfig('npu_whisper_model')) || process.env.NPU_WHISPER_MODEL || DEFAULT_MODEL;
    return { enabled, base: String(url).replace(/\/+$/, ''), model };
}

// ── Availability probe ───────────────────────────────────────────────
// Cached so a down service costs one short request per minute rather than one
// per upload. A negative result is cached for less time than a positive one so
// starting the unit takes effect quickly.
let _probe = { at: 0, ok: false, base: null };
const PROBE_TTL_OK_MS = 60_000;
const PROBE_TTL_FAIL_MS = 15_000;

async function isAvailable(now = Date.now()) {
    const { enabled, base } = await getSettings();
    if (!enabled) return false;
    const ttl = _probe.ok ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS;
    if (_probe.base === base && now - _probe.at < ttl) return _probe.ok;
    let ok = false;
    try {
        const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        ok = res.ok;
    } catch (_) {
        ok = false;
    }
    _probe = { at: now, ok, base };
    if (!ok) log.warn(`[NpuWhisper] not reachable at ${base} — local transcription will use the CPU model`);
    return ok;
}

// ── Decode to 16 kHz mono PCM ────────────────────────────────────────
// One ffmpeg pass. We deliberately produce s16le WAV rather than probing the
// source: the byte length then gives us an exact duration and exact sample
// offsets with no ffprobe binary (the image ships @ffmpeg-installer, which is
// ffmpeg ONLY — there is no ffprobe to call).
async function decodeToWav(audioPath) {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    const ffmpegLib = require('fluent-ffmpeg');
    ffmpegLib.setFfmpegPath(ffmpegInstaller.path);

    const tmp = path.join(os.tmpdir(), `npu-whisper-${crypto.randomUUID()}.wav`);
    try {
        await new Promise((resolve, reject) => {
            ffmpegLib(audioPath)
                .audioChannels(1)
                .audioFrequency(SAMPLE_RATE)
                .audioCodec('pcm_s16le')
                .format('wav')
                .on('end', resolve)
                .on('error', reject)
                .save(tmp);
        });
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (_) { /* never created */ }
        throw err;
    }
    return tmp;
}

/** Locate the `data` chunk. A WAV header is not always 44 bytes — LIST/INFO
 *  chunks from some encoders sit before the samples, and assuming 44 would
 *  splice metadata into the audio. */
function findDataChunk(buf) {
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        return null;
    }
    let off = 12;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'data') return { start: off + 8, size: Math.min(size, buf.length - off - 8) };
        off += 8 + size + (size % 2); // chunks are word-aligned
    }
    return null;
}

/** Minimal 44-byte WAV header for a mono s16le chunk. */
function wavHeader(dataBytes) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(36 + dataBytes, 4);
    h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16);                       // PCM fmt chunk size
    h.writeUInt16LE(1, 20);                        // PCM
    h.writeUInt16LE(1, 22);                        // mono
    h.writeUInt32LE(SAMPLE_RATE, 24);
    h.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
    h.writeUInt16LE(BYTES_PER_SAMPLE, 32);         // block align
    h.writeUInt16LE(16, 34);                       // bits per sample
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(dataBytes, 40);
    return h;
}

/**
 * Choose cut points that land in silence.
 *
 * Cutting on an exact 60 s boundary slices words in half, and Whisper then
 * invents an ending for the fragment on both sides. So for each boundary we
 * scan a window around it in 20 ms frames and cut at the quietest one. Pure
 * sample arithmetic — no extra dependency, and the resulting offsets stay exact.
 */
function planCuts(pcm, totalSec) {
    const cuts = [0];
    if (totalSec <= WINDOW_SEC) return [0, pcm.length];

    const FRAME = Math.floor(0.02 * SAMPLE_RATE);        // 20 ms
    const frameBytes = FRAME * BYTES_PER_SAMPLE;

    let target = WINDOW_SEC;
    while (target < totalSec - 1) {
        const centre = Math.floor(target * BYTES_PER_SEC);
        const lo = Math.max(cuts[cuts.length - 1] + frameBytes, centre - CUT_SEARCH_SEC * BYTES_PER_SEC);
        const hi = Math.min(pcm.length - frameBytes, centre + CUT_SEARCH_SEC * BYTES_PER_SEC);

        let best = centre, bestEnergy = Infinity;
        for (let off = lo; off + frameBytes <= hi; off += frameBytes) {
            let sum = 0;
            // Sub-sample the frame (every 4th sample) — plenty to rank silence
            // and four times cheaper on a two-hour recording.
            for (let i = 0; i < frameBytes; i += BYTES_PER_SAMPLE * 4) {
                const s = pcm.readInt16LE(off + i);
                sum += s * s;
            }
            if (sum < bestEnergy) { bestEnergy = sum; best = off; }
        }
        // Align to a sample boundary: an odd offset would swap the bytes of
        // every sample in the chunk and turn speech into noise.
        best -= best % BYTES_PER_SAMPLE;
        if (best <= cuts[cuts.length - 1]) best = Math.min(centre, pcm.length);
        cuts.push(best);
        target += WINDOW_SEC;
    }
    // Merge a stubby tail into the previous window rather than shipping it as
    // its own request: a couple of seconds of trailing room tone is the single
    // most reliable way to make Whisper hallucinate (see rmsOf below).
    if (pcm.length - cuts[cuts.length - 1] < MIN_TAIL_SEC * BYTES_PER_SEC && cuts.length > 1) {
        cuts[cuts.length - 1] = pcm.length;
    } else {
        cuts.push(pcm.length);
    }
    return cuts;
}

/**
 * RMS of a chunk, sub-sampled.
 *
 * Whisper hallucinates confidently on silence — a 2 s silent tail in testing
 * produced "E aí E aí E aí…" in Portuguese on an English-forced request, and
 * that text landed in the transcript. It is a known property of the model, not
 * of this endpoint, so the fix is to never ASK it about a silent chunk.
 */
function rmsOf(slice) {
    const step = BYTES_PER_SAMPLE * 8;
    let sum = 0, n = 0;
    for (let i = 0; i + BYTES_PER_SAMPLE <= slice.length; i += step) {
        const s = slice.readInt16LE(i);
        sum += s * s;
        n++;
    }
    return n ? Math.sqrt(sum / n) : 0;
}

// ── One request ──────────────────────────────────────────────────────
async function transcribeChunk(base, model, wavBuffer, language, index) {
    const form = new FormData();
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), `chunk-${index}.wav`);
    form.append('model', model);
    if (language) form.append('language', language);

    const res = await fetch(`${base}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`NPU transcribe ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return String(data?.text || '').trim();
}

// The NPU is one device. Two concurrent uploads would queue inside FastFlowLM
// anyway; serialising here keeps our own timeouts meaningful.
let _chain = Promise.resolve();
function runSerialized(fn) {
    const next = _chain.then(() => fn(), () => fn());
    _chain = next.catch(() => {});
    return next;
}

/**
 * Transcribe an audio file on the NPU.
 *
 * @param {string} audioPath              Absolute path; any format ffmpeg reads.
 * @param {object} [options]
 * @param {string} [options.language]     BCP-47 hint; unknown/absent = auto-detect.
 * @returns {Promise<{text, segments, language, durationSec, provider}|null>}
 *          null when the service is disabled, unreachable, or the attempt
 *          failed — the caller then falls back to the CPU model.
 */
async function transcribeWithNpu(audioPath, options = {}) {
    if (!audioPath || !fs.existsSync(audioPath)) throw new Error('Audio file not found');
    if (!(await isAvailable())) return null;

    const { base, model } = await getSettings();
    const raw = String(options.language || '').slice(0, 2).toLowerCase();
    const language = LANG_CODES.has(raw) ? raw : null;

    let wavPath = null;
    try {
        wavPath = await decodeToWav(audioPath);
        const buf = await fs.promises.readFile(wavPath);
        const data = findDataChunk(buf);
        if (!data || data.size === 0) {
            log.warn('[NpuWhisper] decoded file has no audio data');
            return null;
        }
        const pcm = buf.subarray(data.start, data.start + data.size);
        const durationSec = pcm.length / BYTES_PER_SEC;
        if (durationSec > MAX_DURATION_SEC) {
            const e = new Error(`Audio too long (${Math.round(durationSec)}s > ${MAX_DURATION_SEC}s cap)`);
            e.code = 'npu_whisper_too_long';
            throw e;
        }

        const cuts = planCuts(pcm, durationSec);
        const segments = [];
        const started = Date.now();

        for (let i = 0; i < cuts.length - 1; i++) {
            const slice = pcm.subarray(cuts[i], cuts[i + 1]);
            if (slice.length < BYTES_PER_SEC * 0.2) continue;   // <200 ms, nothing to say
            if (rmsOf(slice) < SILENCE_RMS) continue;           // silence -> Whisper invents speech
            const wav = Buffer.concat([wavHeader(slice.length), slice]);
            const text = await runSerialized(() => transcribeChunk(base, model, wav, language, i));
            if (!text) continue;
            segments.push({
                text,
                start: Number((cuts[i] / BYTES_PER_SEC).toFixed(2)),
                end: Number((cuts[i + 1] / BYTES_PER_SEC).toFixed(2)),
                speakerId: 'speaker_0',   // no diarisation on this endpoint, by design
            });
        }

        const text = segments.map(s => s.text).join(' ').trim();
        if (!text) return null;

        log.info(`[NpuWhisper] ${Math.round(durationSec)}s audio in ${Math.round((Date.now() - started) / 1000)}s (${segments.length} segment(s), ${model})`);
        return {
            text,
            segments,
            language: language || options.language || null,
            durationSec: Math.round(durationSec),
            provider: 'npu-whisper',
        };
    } catch (err) {
        if (err?.code === 'npu_whisper_too_long') throw err;
        log.warn(`[NpuWhisper] transcription failed (${err.message}); falling back`);
        // A failure here is often the service going away mid-run — make the
        // next call re-probe instead of trusting the cached "available".
        _probe = { at: 0, ok: false, base: null };
        return null;
    } finally {
        if (wavPath) { try { fs.unlinkSync(wavPath); } catch (_) { /* already gone */ } }
    }
}

module.exports = {
    transcribeWithNpu,
    isAvailable,
    // exported for tests
    _internals: { findDataChunk, wavHeader, planCuts, rmsOf, WINDOW_SEC, BYTES_PER_SEC, SILENCE_RMS },
};
