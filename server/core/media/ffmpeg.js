// @typecheck
/**
 * The one place that finds and runs the ffmpeg binary.
 *
 * Replaces the `fluent-ffmpeg` bootstrap that was repeated in every audio
 * module. Callers build a plain argument list (`buildAudioArgs` covers the
 * 16 kHz speech conversions) and hand it to `runFfmpeg`, which is a thin
 * `child_process.spawn` wrapper that keeps what fluent-ffmpeg's error path
 * gave callers: a `ffmpeg exited with code N: <stderr>` message with the same
 * stderr filtering and the same 100-line bound on what is kept in memory.
 *
 * The argument order of `buildAudioArgs` is the order fluent-ffmpeg 2.1.3
 * produced for the same calls (`-i`, `-y`, audio options, `-filter:a`, output
 * options, target); `ffmpeg.test.js` pins it to recorded fluent output.
 */

'use strict';

const { spawn } = require('child_process');

/** fluent-ffmpeg's default `stdoutLines`: how many stderr lines are kept. */
const STDERR_MAX_LINES = 100;

const NEWLINE = /\r\n|\r|\n/;

/**
 * Path of the bundled ffmpeg binary, resolved lazily so a missing
 * `@ffmpeg-installer/ffmpeg` surfaces where the caller can handle it.
 * @returns {string}
 */
function getFfmpegPath() {
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    if (!ffmpegPath) throw new Error('Cannot find ffmpeg');
    return ffmpegPath;
}

/**
 * Argument list for a single-input audio conversion to a file.
 *
 * @param {object} o
 * @param {string} o.input
 * @param {string} o.output
 * @param {number} [o.channels]       `-ac`
 * @param {number} [o.sampleRate]     `-ar`
 * @param {string} [o.codec]          `-acodec`
 * @param {string[]} [o.filters]      joined into one `-filter:a`
 * @param {string} [o.format]         `-f`
 * @param {number} [o.durationSec]    `-t` (hard clip)
 * @param {string[]} [o.outputOptions] appended verbatim before the target
 * @returns {string[]}
 */
function buildAudioArgs({ input, output, channels, sampleRate, codec, filters, format, durationSec, outputOptions }) {
    const args = ['-i', input, '-y'];
    if (channels != null) args.push('-ac', String(channels));
    if (sampleRate != null) args.push('-ar', String(sampleRate));
    if (codec != null) args.push('-acodec', codec);
    if (filters && filters.length) args.push('-filter:a', filters.join(','));
    if (format != null) args.push('-f', format);
    if (durationSec != null) args.push('-t', String(durationSec));
    if (outputOptions && outputOptions.length) args.push(...outputOptions);
    args.push(output);
    return args;
}

/**
 * Bounded stderr buffer: the last `maxLines` lines, split on \r\n, \r or \n
 * (ffmpeg redraws its progress line with a bare \r).
 * @param {number} maxLines
 */
function createLinesRing(maxLines) {
    const max = maxLines - 1;
    /**
     * @type {string[]}
     */
    const lines = [];
    /**
     * @type {string | null | undefined}
     */
    let current = null;
    let closed = false;
    return {
        /**
         * @param {string} str
         */
        append(str) {
            if (closed || !str) return;
            const parts = str.split(NEWLINE);
            if (parts.length === 1) {
                current = current !== null ? current + parts[0] : parts[0];
                return;
            }
            if (current !== null) lines.push(current + parts.shift());
            current = parts.pop();
            for (const l of parts) lines.push(l);
            if (max > -1 && lines.length > max) lines.splice(0, lines.length - max);
        },
        get() {
            return (current !== null ? lines.concat([current]) : lines).join('\n');
        },
        close() {
            if (closed) return;
            if (current !== null) {
                lines.push(current);
                if (max > -1 && lines.length > max) lines.shift();
                current = null;
            }
            closed = true;
        },
    };
}

/**
 * The lines of ffmpeg's stderr that say what went wrong: everything after the
 * last line that starts with a space or '[' (banner, stream info and module
 * chatter), the same cut fluent-ffmpeg made.
 * @param {string} stderr
 * @returns {string}
 */
function extractFfmpegError(stderr) {
    return stderr.split(NEWLINE).reduce((messages, message) => {
        if (message.charAt(0) === ' ' || message.charAt(0) === '[') return [];
        messages.push(message);
        return messages;
    }, []).join('\n');
}

/**
 * Run ffmpeg to completion.
 *
 * Resolves `{ stderr }` on exit code 0. Rejects with `ffmpeg exited with code
 * N: <error lines>`, `ffmpeg was killed with signal S`, the spawn error
 * itself (ENOENT, ...), or `process ran into a timeout (Ns)` when `timeoutMs`
 * is set and exceeded (the process is then killed). No timeout by default.
 *
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ stderr: string }>}
 */
function runFfmpeg(args, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
        /** @type {string} */
        let bin;
        try {
            bin = getFfmpegPath();
        } catch (err) {
            reject(err);
            return;
        }

        const stderrRing = createLinesRing(STDERR_MAX_LINES);
        const proc = spawn(bin, args, { windowsHide: true });
        /** @type {NodeJS.Timeout | null} */
        let timer = null;
        let exited = false;
        let stderrClosed = false;
        /** @type {Error | null} */
        let exitError = null;
        let settled = false;

        /**
         * @param {Error} err
         */
        const settle = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve({ stderr: stderrRing.get() });
        };

        // Like fluent-ffmpeg: wait for the process AND its stderr to finish, so
        // the error text carries the last lines ffmpeg wrote.
        const maybeFinish = () => {
            if (!exited || !stderrClosed) return;
            if (exitError && /^ffmpeg exited with code/.test(exitError.message)) {
                exitError.message += `: ${extractFfmpegError(stderrRing.get())}`;
            }
            settle(exitError);
        };

        proc.on('error', settle);
        proc.on('exit', (code, signal) => {
            exited = true;
            if (signal) exitError = new Error(`ffmpeg was killed with signal ${signal}`);
            else if (code) exitError = new Error(`ffmpeg exited with code ${code}`);
            maybeFinish();
        });

        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (data) => stderrRing.append(data));
        proc.stderr.on('close', () => {
            stderrRing.close();
            stderrClosed = true;
            maybeFinish();
        });

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                settle(new Error(`process ran into a timeout (${timeoutMs / 1000}s)`));
                proc.kill();
            }, timeoutMs);
        }
    });
}

module.exports = { getFfmpegPath, buildAudioArgs, runFfmpeg, extractFfmpegError, createLinesRing, STDERR_MAX_LINES };
