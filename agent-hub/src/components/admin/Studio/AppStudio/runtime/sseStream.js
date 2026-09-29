/**
 * App Studio runtime — shared SSE-over-POST reader.
 *
 * The App Studio server streams with `data:`-only frames (no `event:` names —
 * see routes/studioAppsRun.js /ai/chat and routes/studioAppBrowse.js): each
 * frame is one JSON object carrying its own `type`. This parser is the single
 * client-side counterpart, used by AppAiChat and the ai_browse step runner —
 * extracted so the two cannot drift on framing details (CRLF, split `data:`
 * chunks across reads, unparseable frames skipped rather than fatal).
 *
 * @param {Response} response — a fetch Response whose body is the SSE stream
 * @param {(evt: object) => void} onEvent — called once per parsed JSON frame.
 *   Throwing from onEvent aborts the read and rethrows to the caller (that is
 *   how AppAiChat turns an {type:'error'} frame into a thrown error).
 */
export async function parseSseStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split('\n\n');
            buffer = frames.pop() || '';
            for (const frame of frames) {
                const line = frame.split('\n').find((l) => l.startsWith('data:'));
                if (!line) continue;
                let evt = null;
                try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
                onEvent(evt);
            }
        }
    } finally {
        // Release the lock so an aborted fetch's body can be GC'd promptly.
        try { reader.releaseLock(); } catch { /* already released */ }
    }
}
