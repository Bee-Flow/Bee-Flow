/**
 * Transcription quality metrics — pure functions, no I/O, no deps.
 *
 * WER is the number that decides whether an audio/provider change actually
 * helped. Everything here is deliberately dependency-free so it can run in CI
 * without an API key.
 */

/**
 * Normalize text for comparison.
 *
 * Light-touch on purpose: WER should measure recognition, not punctuation
 * style. Diacritics are preserved — in Dutch, "een"/"één" and "voor"/"vóór"
 * are different words, so stripping them would hide real errors.
 */
function normalizeWords(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[.,!?;:"“”„'‘’()\[\]{}…]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);
}

/**
 * Levenshtein alignment over two word sequences.
 *
 * Returns the edit counts rather than just the distance, because the mix
 * matters diagnostically: a wall of insertions usually means the recogniser
 * hallucinated over noise, while deletions mean it missed speech entirely —
 * different fixes.
 *
 * @returns {{substitutions:number, deletions:number, insertions:number, distance:number}}
 */
function align(refWords, hypWords) {
    const n = refWords.length;
    const m = hypWords.length;

    // d[i][j] = edit distance between ref[0..i) and hyp[0..j).
    // Backpointers are recomputed by walking the matrix, so store the full grid.
    const d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = 0; i <= n; i++) d[i][0] = i;
    for (let j = 0; j <= m; j++) d[0][j] = j;

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const cost = refWords[i - 1] === hypWords[j - 1] ? 0 : 1;
            d[i][j] = Math.min(
                d[i - 1][j] + 1,        // deletion
                d[i][j - 1] + 1,        // insertion
                d[i - 1][j - 1] + cost, // substitution / match
            );
        }
    }

    // Walk back to attribute the distance to edit types.
    let i = n, j = m;
    let substitutions = 0, deletions = 0, insertions = 0;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0) {
            const cost = refWords[i - 1] === hypWords[j - 1] ? 0 : 1;
            if (d[i][j] === d[i - 1][j - 1] + cost) {
                if (cost === 1) substitutions++;
                i--; j--;
                continue;
            }
        }
        if (i > 0 && d[i][j] === d[i - 1][j] + 1) { deletions++; i--; continue; }
        insertions++; j--;
    }

    return { substitutions, deletions, insertions, distance: d[n][m] };
}

/**
 * Word Error Rate: (S + D + I) / N, where N is the reference word count.
 *
 * Can exceed 1.0 — a recogniser that emits more wrong words than the reference
 * contains is worse than silence, and the metric should say so rather than clamp.
 *
 * @param {string} reference  Ground-truth transcript.
 * @param {string} hypothesis Model output.
 */
function wer(reference, hypothesis) {
    const refWords = normalizeWords(reference);
    const hypWords = normalizeWords(hypothesis);

    if (refWords.length === 0) {
        // No reference to score against. Report insertions rather than divide by zero.
        return {
            wer: hypWords.length === 0 ? 0 : Infinity,
            substitutions: 0, deletions: 0, insertions: hypWords.length,
            refWords: 0, hypWords: hypWords.length,
        };
    }

    const { substitutions, deletions, insertions, distance } = align(refWords, hypWords);
    return {
        wer: distance / refWords.length,
        substitutions, deletions, insertions,
        refWords: refWords.length,
        hypWords: hypWords.length,
    };
}

/**
 * Descriptive diarization stats.
 *
 * NOTE: this is not DER. Real DER needs time-aligned reference speaker turns
 * (RTTM), which we don't have fixtures for. These numbers answer the cruder
 * but still useful question "did diarization collapse?" — e.g. a 4-person
 * meeting coming back as 1 speaker, or fragmenting into 30.
 */
function speakerStats(segments) {
    const list = Array.isArray(segments) ? segments : [];
    const speakers = new Set();
    let turns = 0;
    let last = null;

    for (const seg of list) {
        const id = seg.speakerId || seg.speaker || 'unknown';
        speakers.add(id);
        if (id !== last) { turns++; last = id; }
    }

    const durations = {};
    for (const seg of list) {
        const id = seg.speakerId || seg.speaker || 'unknown';
        const dur = (Number(seg.end) || 0) - (Number(seg.start) || 0);
        if (dur > 0) durations[id] = (durations[id] || 0) + dur;
    }

    return { speakerCount: speakers.size, turns, segments: list.length, durations };
}

module.exports = { normalizeWords, align, wer, speakerStats };
