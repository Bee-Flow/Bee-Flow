// @typecheck
/**
 * Teams WebVTT transcript parsing. Pure, no I/O: split out of teamsArtifacts.js
 * so it can be tested and reused without loading the Graph client.
 */

function vttSeconds(stamp) {
    const parts = String(stamp).trim().split(':');
    let total = 0;
    for (const part of parts) total = total * 60 + Number(part.replace(',', '.'));
    return Number.isFinite(total) ? total : 0;
}

function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

/**
 * Parse a Teams WebVTT transcript into the `{ text, segments }` shape the
 * transcription engines return; `speakerId` is the speaker's display name
 * (from `<v Name>`), or 'Unknown' when the tenant strips attribution. Pure.
 * @param {string} vtt
 */
function parseTeamsVtt(vtt) {
    const segments = [];
    const blocks = String(vtt || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split('\n').filter(l => l.trim() !== '');
        const timeIdx = lines.findIndex(l => l.includes('-->'));
        if (timeIdx === -1) continue;
        const [from, to] = lines[timeIdx].split('-->').map(s => s.trim().split(/\s+/)[0]);
        const body = lines.slice(timeIdx + 1).join(' ');
        if (!body.trim()) continue;
        const voice = /<v\s+([^>]+)>/i.exec(body);
        const text = decodeEntities(body.replace(/<\/?[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        if (!text) continue;
        segments.push({
            start: vttSeconds(from),
            end: vttSeconds(to),
            text,
            speakerId: voice ? decodeEntities(voice[1]).trim() : 'Unknown',
        });
    }
    return { text: segments.map(s => s.text).join(' '), segments };
}

module.exports = { parseTeamsVtt };
