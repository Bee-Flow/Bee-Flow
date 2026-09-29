// @typecheck
/**
 * Pure transcript/diarization shaping — no I/O, no LLM, no deps.
 *
 * Split out of `summaryHelpers.js` deliberately: that module requires
 * `llmClient` at load time, which makes these small pure functions impossible
 * to unit-test (and expensive to stub) without dragging the whole LLM stack in.
 * `summaryHelpers` re-exports everything here, so existing importers are
 * unaffected.
 */

/** Seconds → `MM:SS`, or `HH:MM:SS` once past an hour. */
function formatTime(s) {
    if (s == null) return '00:00';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
    return h > 0 ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
                 : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * Turn the admin's free-text context terms into Voxtral's `context_bias`.
 *
 * The Mistral audio API takes context bias as an **array of up to 100 words or
 * phrases** — there is no free-text `prompt` parameter on this endpoint (see
 * AudioTranscriptionRequest in @mistralai/mistralai). Terms are entered
 * comma/semicolon/newline separated, matching the Azure phrase-list path.
 *
 * @param {string} contextTerms
 * @returns {string[]} At most 100 non-empty terms.
 */
function toContextBias(contextTerms) {
    return String(contextTerms || '')
        .split(/[,;\n]/)
        .map(t => t.trim())
        .filter(Boolean)
        .slice(0, 100);
}

// A merged turn stops absorbing the next segment once it gets this long, or
// when the gap to the next one is this big. Without the caps, a recording with
// ONE diarized speaker — any solo dictation, and any run where diarization
// degraded to a single label — collapsed into one segment covering the whole
// meeting: `segment_count` 1, every transcript timestamp seeking to 0:00, and
// the chapter/action-item stamps unverifiable against the timeline.
const MERGE_MAX_GAP_SECONDS = 2;
const MERGE_MAX_TURN_SECONDS = 60;
const MERGE_MAX_TURN_CHARS = 600;

/**
 * Merge consecutive same-speaker segments and derive the formatted transcript
 * string, the per-speaker stats and total duration.
 */
function buildTranscriptArtifacts(segments) {
    const merged = [];
    for (const seg of segments || []) {
        const last = merged[merged.length - 1];
        const sameSpeaker = last && seg.speakerId === last.speakerId;
        // Keep gluing only while the result stays navigable. A pause longer
        // than a breath is a natural boundary, and so is a turn that has grown
        // past a minute or a paragraph.
        const gap = sameSpeaker ? (Number(seg.start) || 0) - (Number(last.end) || 0) : 0;
        const wouldStayShort = sameSpeaker
            && gap <= MERGE_MAX_GAP_SECONDS
            && ((Number(seg.end) || 0) - (Number(last.start) || 0)) <= MERGE_MAX_TURN_SECONDS
            && (last.text.length + (seg.text || '').length) <= MERGE_MAX_TURN_CHARS;

        // A `gap` segment stands in for audio we could not transcribe (a failed
        // Scaleway chunk). It is a hole, not a turn: never glue it onto a real
        // turn, and never let a real turn absorb it.
        if (sameSpeaker && wouldStayShort && !seg.gap && !last.gap) {
            last.end = seg.end;
            last.text += ' ' + (seg.text || '').trim();
        } else {
            merged.push({
                speaker: seg.speakerId || 'Unknown', speakerId: seg.speakerId || 'Unknown',
                start: seg.start, end: seg.end, text: (seg.text || '').trim(),
                ...(seg.gap ? { gap: true } : {}),
            });
        }
    }
    const totalDuration = (segments && segments.length) ? Math.max(...segments.map(s => s.end || 0)) : 0;
    const transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');

    const speakerMap = {};
    for (const s of merged) {
        // Untranscribable stretches carry no speaker and must not be charged to
        // one: a single failed 10-minute chunk otherwise handed whoever it was
        // attributed to ten fabricated minutes of airtime.
        if (s.gap) continue;
        if (!speakerMap[s.speaker]) speakerMap[s.speaker] = { duration: 0, segments: 0 };
        speakerMap[s.speaker].duration += (s.end || 0) - (s.start || 0);
        speakerMap[s.speaker].segments += 1;
    }
    const speakers = Object.entries(speakerMap).map(([id, d]) => ({
        id, speakingTime: formatTime(d.duration), speakingSeconds: Math.round(d.duration), segments: d.segments,
    }));

    return { merged, transcript, speakers, totalDuration };
}

/**
 * Apply an LLM speaker-name mapping to already-merged segments.
 *
 * The mapping is deliberately many-to-one: the diarizer splits one person
 * across several IDs, so several IDs collapse onto one name. The per-speaker
 * stats must therefore be recomputed from the renamed segments — otherwise one
 * person appears several times over, with their speaking time split across the
 * duplicate rows.
 *
 * Segment turn boundaries are preserved, not re-merged — see the note in the
 * body for why that asymmetry is deliberate.
 *
 * @param {Array} merged  Segments from buildTranscriptArtifacts ({speaker,start,end,text}).
 * @param {object|null} nameMapping  { speakerId: displayName }; null = no remap.
 * @returns {{merged: Array, transcript: string, speakers: Array}}
 */
function applySpeakerNames(merged, nameMapping) {
    const renamed = (merged || []).map(seg => ({
        ...seg,
        speaker: (nameMapping && nameMapping[seg.speaker]) || seg.speaker,
        text: (seg.text || '').trim(),
    }));

    // Turn boundaries are deliberately PRESERVED here — adjacent segments that
    // now share a name are NOT glued together.
    //
    // Gluing them looks tidier but is lossy in the one place it matters. The
    // diarizer's boundary is acoustic evidence; the name is a text-only guess
    // from an LLM. When that guess is wrong, merging destroys the boundary for
    // good (the raw segments are never persisted), and distinct people get
    // fused into one turn. That is exactly how a round of introductions —
    // "Ik ben Ewald." "Ik ben Johan." "Ik ben Tom." — collapsed into a single
    // attributed row. A repeated speaker label on consecutive rows is cosmetic;
    // a fused turn is unrecoverable, so we accept the former.
    //
    // The per-speaker stats below still collapse many-to-one: that is safe,
    // because summing durations discards nothing.
    const byName = {};
    for (const seg of renamed) {
        if (!byName[seg.speaker]) byName[seg.speaker] = { duration: 0, segments: 0 };
        byName[seg.speaker].duration += (seg.end || 0) - (seg.start || 0);
        byName[seg.speaker].segments += 1;
    }

    const speakers = Object.entries(byName).map(([id, d]) => ({
        id,
        speakingTime: formatTime(d.duration),
        speakingSeconds: Math.round(d.duration),
        segments: d.segments,
    }));

    const transcript = renamed
        .map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`)
        .join('\n');

    return { merged: renamed, transcript, speakers };
}

/**
 * Merge AI-written per-speaker prose onto the speaker stat rows.
 *
 * Stored ON speakers[] on purpose: applySpeakerNames above rebuilds that array
 * from the segments, so a rename or merge DROPS these summaries rather than
 * leaving one attached to the wrong person. The "regenerate with the new
 * names?" offer that already follows a speaker edit puts them back.
 *
 * @param {Array<{id: string}>} speakers
 * @param {Record<string, string>} summaries speakerId → prose
 */
function applySpeakerSummaries(speakers, summaries) {
    if (!summaries || !Object.keys(summaries).length) return speakers || [];
    return (speakers || []).map((s) => {
        const text = s && summaries[s.id];
        return text ? { ...s, summary: text } : s;
    });
}

/**
 * Mark the speaker rows whose name came from an acoustic voiceprint match.
 *
 * Without this, every later pass treats all names as equally soft: the
 * text-only `POST /:id/reidentify-speakers` would happily rename a speaker a
 * voice match had already settled. `source` is what lets those paths know
 * which rows they may touch.
 *
 * ONLY the matched rows are stamped. An absent `source` means "derived from
 * the transcript", which is what every row has always been — so a note with no
 * voice matches keeps exactly the payload it had before this feature existed.
 * `manual` is stamped elsewhere, by the speaker-edit route.
 *
 * @param {Array<{id: string}>} speakers  Rows AFTER applySpeakerNames (ids are display names).
 * @param {Object<string,string>|null} voiceprintMapping  diarizer id → name, from the voice match.
 */
function tagSpeakerProvenance(speakers, voiceprintMapping) {
    const matched = new Set(Object.values(voiceprintMapping || {}));
    if (!matched.size) return speakers || [];
    return (speakers || []).map(s => (s && matched.has(s.id) ? { ...s, source: 'voiceprint' } : s));
}

/** Language → the word used for an unidentified speaker. Falls back to English. */
const SPEAKER_WORD = {
    nl: 'Spreker', en: 'Speaker', de: 'Sprecher',
    fr: 'Intervenant', es: 'Interlocutor', it: 'Interlocutore', pt: 'Orador',
};

/**
 * Complete a speaker-name mapping so no diarizer ID is ever shown raw.
 *
 * `identifySpeakerNames` deliberately returns only the IDs it can confidently
 * name (real self-introductions / addressed-by-name), omitting the rest rather
 * than inventing labels. This floor gives every still-unnamed ID a clean,
 * stable, language-appropriate generic label ("Spreker 1".."Spreker N" / "Speaker
 * 1"..) numbered in the order the IDs are given — so a meeting where nobody
 * introduces themselves shows tidy generic speakers instead of the raw pyannote
 * `SPEAKER_00`. Pure and deterministic.
 *
 * @param {Array<string|{id:string}>} speakerIds  Diarizer IDs (bare or stat rows).
 * @param {object|null} nameMapping  { id: realName } from identifySpeakerNames.
 * @param {string} language  Meeting language code (e.g. 'nl').
 * @returns {object} A complete mapping: real names kept, unnamed IDs → generic labels.
 */
function fillGenericSpeakerLabels(speakerIds, nameMapping = {}, language = 'en') {
    const word = SPEAKER_WORD[String(language || 'en').slice(0, 2).toLowerCase()] || SPEAKER_WORD.en;
    const ids = (Array.isArray(speakerIds) ? speakerIds : [])
        .map(s => (typeof s === 'string' ? s : (s && s.id)))
        .filter(Boolean);
    const out = { ...(nameMapping || {}) };
    let n = 0;
    for (const id of ids) {
        const named = out[id];
        if (named && typeof named === 'string' && named.trim()) continue; // keep real name
        n += 1;
        out[id] = `${word} ${n}`;
    }
    return out;
}

/**
 * Attach a speaker to each transcript segment from a separate diarizer's turns,
 * by maximum time overlap. Used by the hybrid path where transcription (e.g.
 * cloud Whisper) and diarization (local pyannote) come from different engines.
 *
 * A faithful JS port of WhisperX's segment-level `assign_word_speakers`: for a
 * segment [s.start, s.end], sum the intersection with every diarizer turn per
 * speaker and pick the speaker with the greatest total overlap. Segments with no
 * overlapping turn keep `fallback` (so downstream never sees an empty speaker).
 *
 * @param {Array<{start:number,end:number,text?:string,gap?:boolean}>} segments  Transcript segments (need start/end; `gap` marks a failed chunk).
 * @param {Array<{start:number,end:number,speaker:string}>} diarTurns  Diarizer speaker turns.
 * @param {string} [fallback='speaker_0']  Speaker for segments with no overlap.
 * @returns {Array} `segments` with a `speakerId` on each (input is not mutated).
 */
function assignSpeakersByOverlap(segments, diarTurns, fallback = 'speaker_0') {
    const turns = Array.isArray(diarTurns) ? diarTurns : [];
    return (segments || []).map(seg => {
        // A gap segment spans a whole failed chunk. Running it through the
        // overlap matcher would credit ten minutes of silence to whichever
        // speaker happened to talk near its edges; leave it unattributed.
        if (seg.gap) return { ...seg, speakerId: fallback };
        const s = Number(seg.start) || 0;
        const e = Number(seg.end) || 0;
        const totals = new Map();
        for (const t of turns) {
            const inter = Math.min(Number(t.end) || 0, e) - Math.max(Number(t.start) || 0, s);
            if (inter > 0 && t.speaker != null) {
                totals.set(t.speaker, (totals.get(t.speaker) || 0) + inter);
            }
        }
        let best = fallback, max = 0;
        for (const [spk, tot] of totals) {
            if (tot > max) { max = tot; best = spk; }
        }
        return { ...seg, speakerId: best };
    });
}

/** Parse a `MM:SS` / `HH:MM:SS` clock string → seconds, or null. */
function parseClock(str) {
    const m = /^(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?$/.exec(String(str || '').trim());
    if (!m) return null;
    return m[3] !== undefined
        ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        : Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Collect the clock stamps a transcript's own lines carry
 * (`[Name] MM:SS - MM:SS: text`) — the ground truth LLM-copied timestamps are
 * validated against.
 *
 * @returns {{starts: number[], lastEnd: number}}
 */
function extractTranscriptClocks(transcript) {
    const starts = [];
    let lastEnd = 0;
    const re = /^\[[^\]]*\]\s+(\d{1,3}:\d{2}(?::\d{2})?)\s+-\s+(\d{1,3}:\d{2}(?::\d{2})?):/gm;
    let m;
    while ((m = re.exec(String(transcript || ''))) !== null) {
        const s = parseClock(m[1]);
        const e = parseClock(m[2]);
        if (s !== null) starts.push(s);
        if (e !== null && e > lastEnd) lastEnd = e;
    }
    return { starts, lastEnd };
}

/**
 * Validate an LLM-copied timestamp against the transcript's real line stamps.
 *
 * The model is asked to copy stamps verbatim but sometimes invents one or
 * shortens `01:05:30` to `05:30` — which used to make the client seek an hour
 * early (or to 0:00 for junk). Rules:
 *   - unparseable → '' (the caller drops the chip/chapter; the phantom-marker
 *     rule: a bad timestamp must disappear, not masquerade as a moment)
 *   - past the end of the meeting → ''
 *   - hour-less stamp in a >1h meeting that matches no real line start, while
 *     `+1h`/`+2h` does → repaired to the matching hour
 *   - otherwise → returned as-is
 *
 * @param {string} raw  The model-supplied stamp.
 * @param {{starts?: number[], lastEnd?: number}} clocks  From extractTranscriptClocks.
 * @returns {string} A usable stamp, possibly repaired, or ''.
 */
function sanitizeTimestamp(raw, { starts = [], lastEnd = 0 } = {}) {
    // Accept a numeric seconds value. LLM replies sometimes give `"start": 750`
    // (or the bare string "750") instead of the "MM:SS"/"HH:MM:SS" clock string
    // the prompt asks for — and a plain number has no colon, so parseClock below
    // would reject it and the caller would drop the whole chapter/action item.
    // Treat a bare number as seconds and format it, within bounds.
    if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim()))) {
        const secNum = Number(raw);
        if (!Number.isFinite(secNum) || secNum < 0) return '';
        if (lastEnd > 0 && secNum > lastEnd + 1) return '';
        return formatTime(Math.round(secNum));
    }
    const trimmed = String(raw || '').trim();
    const sec = parseClock(trimmed);
    if (sec === null) return '';
    if (lastEnd > 0 && sec > lastEnd) return '';

    const nearLine = (v) => starts.some(s => Math.abs(s - v) <= 20);
    const hasHour = /^\d{1,3}:\d{2}:\d{2}$/.test(trimmed);
    if (!hasHour && lastEnd >= 3600 && starts.length > 0 && !nearLine(sec)) {
        for (const candidate of [sec + 3600, sec + 7200]) {
            if (candidate <= lastEnd && nearLine(candidate)) return formatTime(candidate);
        }
    }
    return trimmed;
}

/**
 * ── DRIE UITKOMSTEN, DRIE WAARDEN ───────────────────────────────────
 *
 * Een artefactpass (summaryHelpers.extractMeetingArtifacts) kan drie dingen
 * doen, en alleen de eerste twee mogen bestaande actiepunten, besluiten en
 * vragen vervangen:
 *
 *   1. gelukt, met resultaat  → de vier lijsten, `ok: true`
 *   2. gelukt, en leeg        → vier LEGE lijsten, `ok: true`
 *      ("in deze vergadering is niets afgesproken" — dit MOET de oude
 *       AI-rijen opruimen, anders blijven ze eeuwig staan)
 *   3. mislukt                → ARTIFACTS_FAILED
 *      (onparseerbaar antwoord, time-out, omgevallen call — er is niets
 *       gelezen, dus er valt niets te vervangen)
 *
 * Uitkomst 2 en 3 zagen er ooit identiek uit: vier lege lijsten. Het verschil
 * werd toen gedragen door een LOSSE VLAG naast die lijsten (`ok`), en dat is
 * precies het soort onderscheid dat een schrijver vergeet mee te nemen — twee
 * van de vier schrijvers deden dat ook, en een handvol testfixtures ook.
 *
 * Daarom draagt de WAARDE het nu zelf: een mislukte pass heeft helemaal geen
 * lijsten. Wie ze toch doorgeeft aan `updateTranscription` geeft `undefined`
 * door, en dat betekent daar "raak deze kolom niet aan" — de veilige uitkomst
 * is de uitkomst die je per ongeluk krijgt.
 */
const ARTIFACTS_FAILED = Object.freeze({ ok: false });

/**
 * De ene vraag die elke schrijver stelt: heeft deze pass daadwerkelijk een
 * antwoord gelezen?
 *
 * ONBEKEND VERSMALT. Niet `ok !== false` — dat liet alles door wat de vlag
 * niet zette, ook een antwoord zonder lijsten, en de merge maakte daar "de
 * vergadering was leeg" van. Bruikbaar is alleen wat er als afgeronde pass
 * uitziet: de drie lijsten zijn er, en de vlag zegt niet nee.
 *
 * @param {any} artifacts wat extractMeetingArtifacts teruggaf
 * @returns {boolean} true = deze uitkomst mag bestaande artefacten vervangen
 */
function artifactsUsable(artifacts) {
    if (!artifacts || typeof artifacts !== 'object' || artifacts.ok === false) return false;
    return Array.isArray(artifacts.actionItems)
        && Array.isArray(artifacts.decisions)
        && Array.isArray(artifacts.questions);
}

/** Human label for a transcription provider id, for user-facing notices. */
const PROVIDER_LABELS = {
    voxtral: 'Voxtral', whisperx: 'WhisperX', scaleway: 'Scaleway',
    azure: 'Azure Speech', whisper_azure: 'Azure Whisper', local: 'local transcription',
};

/**
 * User-facing notice lines for pipeline events that happen after the 202 was
 * sent (engine fallback, truncated transcription). The note itself is the only
 * channel left to the user at that point, so these are prepended to the
 * summary by the caller.
 *
 * @param {{providerFallback?: {to: string}|null,
 *          truncated?: {atSeconds: number}|null,
 *          voiceprint?: {failed?: boolean, truncated?: boolean}|null,
 *          artifactsFailed?: boolean,
 *          language?: string}} [opts]
 * @returns {string[]} zero or more notice lines
 */
function buildPipelineNotices({ providerFallback = null, truncated = null, voiceprint = null, artifactsFailed = false, language = 'nl' } = {}) {
    const nl = String(language).toLowerCase().startsWith('nl');
    const lines = [];
    if (providerFallback) {
        const to = PROVIDER_LABELS[providerFallback.to] || providerFallback.to;
        lines.push(nl
            ? `⚠️ Lokale transcriptie kon deze opname niet aan; in plaats daarvan getranscribeerd via ${to}.`
            : `⚠️ Local transcription couldn't handle this recording; transcribed via ${to} instead.`);
    }
    if (truncated) {
        const at = formatTime(truncated.atSeconds);
        lines.push(nl
            ? `⚠️ De transcriptie is voortijdig gestopt op ${at} — de rest van de opname ontbreekt. Probeer 'Opnieuw transcriberen' of een andere provider.`
            : `⚠️ Transcription stopped early at ${at} — the rest of the recording is missing. Try 'Re-transcribe' or another provider.`);
    }
    // Voiceprint identification is optional and best-effort, so a SUCCESSFUL
    // match gets no notice — the real names in the transcript are the notice.
    // Only the two cases where the user might otherwise wonder why a colleague
    // wasn't recognised are surfaced.
    if (voiceprint?.failed) {
        lines.push(nl
            ? `ℹ️ Automatische stemherkenning is niet gelukt voor deze opname; sprekers zijn uit het gesprek zelf herkend.`
            : `ℹ️ Automatic voice recognition failed for this recording; speakers were identified from the conversation instead.`);
    } else if (voiceprint?.truncated) {
        lines.push(nl
            ? `ℹ️ Je organisatie heeft meer dan 50 stemprofielen; voor deze opname zijn de 50 meest waarschijnlijke gebruikt.`
            : `ℹ️ Your organisation has more than 50 voice profiles; the 50 most likely ones were used for this recording.`);
    }
    // Een MISLUKTE artefactpass moet het zeggen. Zonder deze regel is het
    // resultaat niet te onderscheiden van een vergadering waarin niets is
    // afgesproken: geen actiepunten, geen besluiten, geen vragen — en niemand
    // die op 'Opnieuw' drukt, want er lijkt niets mis. Wat er al stond is
    // bewaard; dat is de andere helft en die staat er ook in.
    if (artifactsFailed) {
        lines.push(nl
            ? `⚠️ Het bepalen van actiepunten, besluiten en vragen is niet gelukt voor deze opname; wat er al stond is bewaard. Probeer 'Opnieuw'.`
            : `⚠️ Working out the action items, decisions and questions failed for this recording; whatever was already there has been kept. Try 'Regenerate'.`);
    }
    return lines;
}

module.exports = {
    formatTime,
    toContextBias,
    buildTranscriptArtifacts,
    applySpeakerNames,
    applySpeakerSummaries,
    tagSpeakerProvenance,
    fillGenericSpeakerLabels,
    assignSpeakersByOverlap,
    buildPipelineNotices,
    artifactsUsable,
    ARTIFACTS_FAILED,
    parseClock,
    extractTranscriptClocks,
    sanitizeTimestamp,
};
