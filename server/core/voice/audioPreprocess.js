/**
 * Audio conditioning for speech-to-text.
 *
 * Speech models are trained on ~16 kHz mono speech at broadly even loudness.
 * Meeting-room and Nextcloud Talk recordings arrive far from that: quiet,
 * uneven between near and far speakers, and carrying low-frequency room
 * rumble. Conditioning the audio before it reaches a recogniser measurably
 * helps — especially for the far-field case.
 *
 * This chain was tuned inline on the Azure branch of routes/transcriptions.js
 * (which has always preprocessed) and lives here so every provider can share
 * the same treatment.
 *
 * Filter choices, and why:
 *   - highpass=f=80  cuts DC offset and low-frequency rumble. 80Hz sits below
 *                    the male speaking fundamental (~85Hz), so it removes room
 *                    noise without touching voice.
 *   - loudnorm       EBU R128 normalization. Preferred over dynaudnorm for
 *                    speech: it evens out quiet vs loud speakers without the
 *                    pumping artefacts dynaudnorm introduces on pauses.
 *   - NO lowpass     Deliberate. Dutch fricatives (s, f, sh) carry their
 *                    energy at 4-8kHz; a lowpass would cut exactly the band
 *                    that distinguishes them, costing accuracy.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../../telemetry/log');

const FILTERS = [
    'highpass=f=80',
    'loudnorm',
];

const SAMPLE_RATE = 16000;
const CHANNELS = 1;

/** Output containers we know how to emit, mapped to their ffmpeg codec. */
const FORMATS = {
    // Lossless, universally accepted. What the Azure SDK requires.
    wav: { codec: 'pcm_s16le', format: 'wav' },
    // Lossless but ~half the bytes of WAV — worth it for large cloud uploads.
    flac: { codec: 'flac', format: 'flac' },
};

/**
 * Condition an audio file for speech recognition.
 *
 * Never throws on ffmpeg failure: a conditioning problem should degrade to
 * "transcribe the original" rather than fail the user's upload. The caller
 * gets `preprocessed: false` and the original path back.
 *
 * @param {string} inputPath           Path to the source audio.
 * @param {object} [opts]
 * @param {'wav'|'flac'} [opts.format] Output container (default 'wav').
 * @param {string} [opts.label]        Prefix for the temp file, for log clarity.
 * @param {number} [opts.maxSeconds]   Hard-clip the output to this many seconds.
 *        Used by voiceprint enrollment, where pyannote rejects anything over
 *        30s. Omitted by every other caller, so their output is unchanged.
 * @returns {Promise<{path: string, preprocessed: boolean, cleanup: () => void}>}
 *          `cleanup()` removes the temp file (no-op when preprocessing was
 *          skipped, so it never deletes the caller's original).
 */
async function preprocessForStt(inputPath, opts = {}) {
    const format = FORMATS[opts.format] ? opts.format : 'wav';
    const { codec, format: container } = FORMATS[format];
    const label = opts.label || 'stt';

    const noop = { path: inputPath, preprocessed: false, cleanup: () => {} };

    let ffmpegLib;
    try {
        const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
        ffmpegLib = require('fluent-ffmpeg');
        ffmpegLib.setFfmpegPath(ffmpegInstaller.path);
    } catch (err) {
        log.warn(`[AudioPreprocess] ffmpeg unavailable, sending original audio: ${err.message}`);
        return noop;
    }

    // pid + millisecond is not unique: this runs concurrently within ONE process
    // (several uploads, or the diarize and identify legs of the same job), so
    // two calls in the same tick shared an output path — one overwrote the
    // other's audio and the loser's `unlink` deleted the winner's file.
    const outPath = path.join(os.tmpdir(), `${label}-${crypto.randomUUID()}.${container}`);
    const started = Date.now();

    try {
        await new Promise((resolve, reject) => {
            const chain = ffmpegLib(inputPath)
                .audioChannels(CHANNELS)
                .audioFrequency(SAMPLE_RATE)
                .audioCodec(codec)
                .format(container)
                .audioFilters(FILTERS);
            // Voiceprint enrollment only: pyannoteAI rejects anything over 30s,
            // and a browser recorder's wall-clock timer is not the encoded
            // duration. Omitted by every other caller, so their output is
            // byte-identical.
            if (Number(opts.maxSeconds) > 0) chain.duration(Number(opts.maxSeconds));
            chain
                .on('end', resolve)
                .on('error', reject)
                .save(outPath);
        });
    } catch (err) {
        // Corrupt input, unsupported codec, ffmpeg missing a library — none of
        // these should cost the user their transcription.
        log.warn(`[AudioPreprocess] Conditioning failed, sending original audio: ${err.message}`);
        try { fs.unlinkSync(outPath); } catch (_) {}
        return noop;
    }

    const inBytes = statSizeOrNull(inputPath);
    const outBytes = statSizeOrNull(outPath);
    log.info(
        `[AudioPreprocess] ${label}: ${format} ${SAMPLE_RATE / 1000}kHz mono` +
        `${inBytes && outBytes ? ` (${mb(inBytes)} → ${mb(outBytes)})` : ''}` +
        ` in ${Date.now() - started}ms`
    );

    return {
        path: outPath,
        preprocessed: true,
        cleanup: () => { try { fs.unlinkSync(outPath); } catch (_) {} },
    };
}

function statSizeOrNull(p) {
    try { return fs.statSync(p).size; } catch (_) { return null; }
}

function mb(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

module.exports = { preprocessForStt, FILTERS, SAMPLE_RATE };
