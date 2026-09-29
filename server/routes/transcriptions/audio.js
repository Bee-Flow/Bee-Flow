/**
 * Transcriptions — audio playback.
 *
 * GET /:id/audio — serve the saved recording with byte-range support, from
 * the local copy or the durable object-storage copy.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const transcriptionStore = require('../../stores/transcriptionStore');
const { requireAuth } = require('../../auth/permissions');
const { resolveAccessContext } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { flag } = require('./schemas');

// `?download=1` is de reddingsluik-parameter en de enige die deze route leest.
// Strict, want `?downlaod=1` streamde de opname `inline` terug: de browser
// speelde hem af in plaats van hem op te slaan, en dát opslaan is voor een
// browseropname die geen duurzame kopie heeft de enige uitweg.
const DOWNLOAD_TEXT = 'download is true of false.';
const AudioQuery = z.object({ download: flag(DOWNLOAD_TEXT) }).strict();

// ── Serve audio file for playback ────────────────────────

router.get('/:id/audio', requireAuth, validate({ query: AudioQuery }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        const { parseRangeHeader } = require('../../core/http/httpRange');
        const { contentTypeForAudio, repairSavedAudio } = require('../../core/meetingNotes/savedAudioStore');
        // `?download=1` is the rescue hatch: it lets a user save a browser
        // recording that has no durable copy, which is otherwise unrecoverable.
        const asAttachment = req.query.download === true;

        let audioExists = false;
        if (transcription.audioPath) { try { await fs.promises.access(transcription.audioPath); audioExists = true; } catch { audioExists = false; } }

        // Shared by both branches so the local and object-storage paths cannot
        // drift apart — that drift is exactly why a recording served from RustFS
        // could not be seeked and, on iOS Safari, would not play at all.
        const sendHeaders = (contentType, fileName) => {
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', `${asAttachment ? 'attachment' : 'inline'}; filename="${fileName}"`);
            res.setHeader('Cache-Control', 'private, max-age=3600');
        };

        if (!audioExists) {
            // Local copy gone (pod restart / other replica) — stream the durable
            // object-storage copy, WITH range support.
            if (transcription.audioStorageKey) {
                const storageStore = require('../../stores/storageStore');
                if (await storageStore.ensureAvailable()) {
                    try {
                        const key = transcription.audioStorageKey;
                        const head = await storageStore.headFile(key);
                        const total = Number(head.contentLength) || 0;
                        // Extension-derived, never the old `|| 'audio/mpeg'`
                        // default — that labelled every WebM recording as MP3
                        // and the browser then refused to decode it.
                        const contentType = contentTypeForAudio(key, head.contentType);
                        const fileName = transcription.fileName || path.basename(key);

                        const range = parseRangeHeader(req.headers.range, total);
                        if (range && range.invalid) {
                            res.setHeader('Content-Range', `bytes */${total}`);
                            return res.status(416).end();
                        }

                        sendHeaders(contentType, fileName);
                        const { stream, contentLength } = await storageStore.streamFile(key, { range: range || null });
                        if (range) {
                            res.status(206);
                            res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
                        }
                        if (contentLength) res.setHeader('Content-Length', String(contentLength));
                        stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
                        stream.pipe(res);
                        return;
                    } catch (e) {
                        log.error('[Transcriptions] Object-storage audio fetch failed:', e.message);
                    }
                }
            }
            return res.status(404).json({ error: 'Audio file not available' });
        }

        // Local file present. On a multi-replica deploy this pod is the only one
        // that can see it, so a note with no durable copy gets backed up now —
        // every play is a repair opportunity we should not waste.
        if (!transcription.audioStorageKey) {
            repairSavedAudio({
                id: transcription.id,
                ownerId: transcription.ownerId || userId,
                audioPath: transcription.audioPath,
                audioStorageKey: transcription.audioStorageKey,
            }).catch(() => {});
        }

        const audioPath = transcription.audioPath;
        const ext = path.extname(audioPath).toLowerCase();
        const contentType = contentTypeForAudio(audioPath);
        const stat = await fs.promises.stat(audioPath);
        const fileSize = stat.size;
        const fileName = transcription.fileName || `audio${ext}`;

        // HTML5 <audio> elements seek/scrub via byte-range requests. Some
        // formats (notably webm/mp4/m4a) refuse to play without
        // `206 Partial Content` + `Accept-Ranges: bytes`.
        sendHeaders(contentType, fileName);

        const range = parseRangeHeader(req.headers.range, fileSize);
        if (range && range.invalid) {
            res.setHeader('Content-Range', `bytes */${fileSize}`);
            return res.status(416).end();
        }
        if (range) {
            res.status(206);
            res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${fileSize}`);
            res.setHeader('Content-Length', String(range.end - range.start + 1));
            fs.createReadStream(audioPath, { start: range.start, end: range.end }).pipe(res);
            return;
        }

        // No range header — full file.
        res.setHeader('Content-Length', String(fileSize));
        fs.createReadStream(audioPath).pipe(res);
    } catch (err) {
        log.error('[Transcriptions] Audio serve error:', err.message);
        res.status(500).json({ error: 'Failed to serve audio' });
    }
});

module.exports = router;
