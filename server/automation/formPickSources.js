/**
 * The apps a form question can pick FROM.
 *
 * An `app_pick` field asks the person filling a form for a RECORD in an app
 * they already use — the Fireflies transcript of last Tuesday's call, the Bee
 * Flow meeting note, the customer's email — instead of asking them to copy and
 * paste it. They search, they click, and the routine receives the record's text
 * the same way it receives the text of an uploaded document.
 *
 * This module is the registry of what may be picked, and nothing else: pure
 * data plus pure mappers, no I/O, no dispatch. The route
 * (routes/automation/formPublic.js) does the searching and the reading; it asks
 * here WHICH tool to call and HOW to read what comes back.
 *
 * Four properties the whole design turns on:
 *
 *   • THE FILLER'S OWN ACCESS, never the author's. A form question says "pick a
 *     Fireflies transcript"; WHICH transcripts exist is answered by the
 *     credentials of whoever is filling it in. An author cannot use this to
 *     read a colleague's mailbox — the search runs as the filler, against the
 *     filler's connection, and shows the filler's records. This is why
 *     `app_pick` requires a signed-in filler (formPublic's PUBLIC_FORMS_ENABLED
 *     is off, so every filler is one today) and refuses outright when the form
 *     is served anonymously: an anonymous visitor has no connections to search,
 *     and falling back to the author's would be a data leak with a search box
 *     on it.
 *
 *   • A CLOSED LIST OF READ-ONLY CALLS. The browser never names a tool. It
 *     names a FIELD; the field names a source in this registry; the source
 *     names the two tools it may use, and the args are built HERE from a
 *     bounded query string. So the picker cannot be turned into "execute any
 *     integration tool with any arguments as me" — which is what a generic
 *     endpoint would have been. Every tool named below reads; none of them
 *     write, send or delete.
 *
 *   • ONE SHAPE OUT, WHATEVER WENT IN. Fireflies answers with sentences, Gmail
 *     with a MIME body, a meeting note with a summary and a transcript. A
 *     routine binding `trigger.output.<field>.text` must not have to care. Each
 *     source flattens its own record to `{ title, subtitle, url, text }`, the
 *     same contract `file` fields got from formUploadText — so an ai_step reads
 *     a picked transcript exactly as it reads an attached PDF.
 *
 *   • THE DIRECTION IS INWARD. CLAUDE.md's rule about personal data is about
 *     what LEAVES Bee Flow; this pulls data IN, from a system the person
 *     already has open in another tab. Nothing here sends anything outward but
 *     a search term the filler typed.
 *
 * Adding a source is one entry. Deliberately absent for now: Nextcloud Mail
 * (its search needs a mailbox id first, so it is a two-step picker rather than
 * a search box) and YouTrack (its query language is not something a form filler
 * should have to write).
 */

'use strict';

/** What one picked record may contribute to a run. Mirrors formUploadText. */
const MAX_TEXT_CHARS = 60_000;
/** How many results one search may return, whatever the caller asks for. */
const MAX_RESULTS = 25;
const DEFAULT_RESULTS = 10;
/** A search term is a search term, not a payload. */
const MAX_QUERY_LEN = 200;
/** How many records one `multiple` field may collect. */
const MAX_PICKS = 10;
const DEFAULT_MAX_PICKS = 5;
/** A picked record's id, as it came back from the app. */
const MAX_RECORD_ID_LEN = 300;
const MAX_TITLE_LEN = 300;
const MAX_SUBTITLE_LEN = 300;

function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : '';
}

/** The array inside a tool result, wherever that tool decided to put it. */
function resultRows(raw, key) {
    if (Array.isArray(raw)) return raw;
    if (!raw || typeof raw !== 'object') return [];
    const rows = raw[key];
    return Array.isArray(rows) ? rows : [];
}

/** A date as a person reads it; the raw string when it is not a date at all. */
function humanDate(v) {
    if (!v) return '';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v).slice(0, 40);
    return d.toISOString().slice(0, 10);
}

/** Join the non-empty parts of a subtitle line. */
function line(...parts) {
    return parts.filter(p => typeof p === 'string' && p.trim()).join(' · ').slice(0, MAX_SUBTITLE_LEN);
}

/**
 * Google Drive's `q` is an operator language, not a search box. A person typing
 * "offerte" means `name contains 'offerte'`, and the quote they typed by
 * accident must not end the literal.
 */
function driveQuery(query) {
    const q = query.replace(/['\\]/g, '\\$&');
    return q ? `name contains '${q}' and trashed = false` : 'trashed = false';
}

/**
 * An email as a routine should read it: the headers that say who and when,
 * then the body. Built as a list-then-join rather than a clever filter, so a
 * message missing its From line still renders with the blank line in the right
 * place.
 */
function mailText(raw, bodyKeys) {
    const headers = [
        raw?.from ? `From: ${str(raw.from, 300)}` : '',
        raw?.to ? `To: ${str(raw.to, 600)}` : '',
        raw?.date ? `Date: ${str(raw.date, 100)}` : '',
        raw?.subject ? `Subject: ${str(raw.subject, 300)}` : '',
    ].filter(Boolean);
    let body = '';
    for (const k of bodyKeys) {
        if (typeof raw?.[k] === 'string' && raw[k]) { body = str(raw[k], MAX_TEXT_CHARS); break; }
    }
    return headers.length ? `${headers.join('\n')}\n\n${body}` : body;
}

/** A bounded list of short strings — a `data` field, never a payload. */
function strList(raw, max = 25, len = 200) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const v of raw) {
        const one = typeof v === 'string' ? v : (v && typeof v === 'object' ? (v.filename || v.name || v.title || v.text || '') : '');
        if (typeof one === 'string' && one.trim()) out.push(one.slice(0, len));
        if (out.length >= max) break;
    }
    return out;
}

/** An ISO timestamp when the source gave something a Date can read, else ''. */
function isoDate(v) {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** "45 min" / 45 / "45" → 45. Minutes, because that is how a meeting is read. */
function minutes(v) {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Drop the empty keys from a `data` object.
 *
 * A structured field that is present-but-empty is worse than an absent one: a
 * routine branching on `data.organizer` cannot tell "this meeting had no
 * organizer" from "this source does not report one", and an ai_step handed
 * `organizer: ""` will cheerfully reason about the empty string.
 */
function compact(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined || v === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        out[k] = v;
    }
    return out;
}

/** The structured half of an email, shared by Gmail and Outlook. */
function mailData(raw) {
    return compact({
        from: str(raw?.from, 300),
        to: str(raw?.to, 600),
        subject: str(raw?.subject, 300),
        date: isoDate(raw?.date),
        threadId: str(raw?.threadId, 200),
        hasAttachments: Array.isArray(raw?.attachments) ? raw.attachments.length > 0 : undefined,
        attachmentNames: strList(raw?.attachments, 20),
    });
}

const SOURCES = [
    {
        id: 'fireflies_transcript',
        appId: 'fireflies',
        app: 'Fireflies',
        label: 'Fireflies meeting transcript',
        // What the field's search box says before anything is typed.
        searchHint: 'Search your Fireflies meetings by title',
        searchTool: 'fireflies_list_transcripts',
        // `title` is the only filter the tool offers; blank lists the most
        // recent meetings, which is the right empty state for a picker.
        searchArgs: (query, limit) => (query ? { title: query, limit } : { limit }),
        mapResults: (raw) => resultRows(raw, 'results').map(r => ({
            id: str(r?.id, MAX_RECORD_ID_LEN),
            title: str(r?.title, MAX_TITLE_LEN) || 'Untitled meeting',
            subtitle: line(humanDate(r?.date), r?.duration, r?.organizer),
            url: str(r?.url, 500),
        })),
        fetchTool: 'fireflies_get_transcript',
        fetchArgs: (recordId) => ({ transcriptId: recordId }),
        mapRecord: (raw) => {
            const sentences = Array.isArray(raw?.sentences) ? raw.sentences : [];
            // Speaker-prefixed lines, because "who said it" is half of what a
            // routine summarising a call has to work with.
            const body = sentences
                .map(s => `${s?.speaker ? `${s.speaker}: ` : ''}${str(s?.text, 4000)}`)
                .join('\n');
            return {
                title: str(raw?.title, MAX_TITLE_LEN),
                subtitle: line(humanDate(raw?.date), raw?.duration),
                url: str(raw?.url, 500),
                // The tool caps at 500 sentences and says so; carry that
                // upward rather than presenting a clipped call as a whole one.
                text: body,
                partial: !!raw?.truncated,
                // The METADATA of the call, not a second copy of it. A routine
                // that only needs "when was this and who was on it" should not
                // have to send a model the whole transcript to find out.
                data: compact({
                    date: isoDate(raw?.date),
                    durationMinutes: minutes(raw?.duration),
                    organizer: str(raw?.organizer, 300),
                    participants: strList(raw?.participants, 50, 300),
                    speakers: strList(raw?.speakers, 50, 200),
                    sentenceCount: Number.isFinite(raw?.sentenceCount) ? raw.sentenceCount : sentences.length,
                }),
            };
        },
    },
    {
        id: 'meeting_note',
        appId: 'transcriptions',
        app: 'Bee Flow',
        label: 'Bee Flow meeting note',
        searchHint: 'Search your meeting notes',
        // First-party: no integration, no connection, no outbound call. The
        // store's own read ACL is the authorisation (owner, shared-with,
        // published-to-my-org-and-group) — the same predicate the Meeting notes
        // library uses, so a picker can never show a note its owner cannot open.
        internal: 'transcriptions',
    },
    {
        id: 'gmail_message',
        appId: 'gmail',
        app: 'Gmail',
        label: 'Gmail email',
        searchHint: 'Search your email (from:, subject:, has:attachment …)',
        searchTool: 'gmail_search',
        // gmail_search refuses an empty query; the most recent inbox mail is
        // the sensible thing to show before anything is typed.
        searchArgs: (query, limit) => ({ query: query || 'in:inbox', maxResults: limit }),
        mapResults: (raw) => resultRows(raw, 'results').map(r => ({
            id: str(r?.id, MAX_RECORD_ID_LEN),
            title: str(r?.subject, MAX_TITLE_LEN) || '(no subject)',
            subtitle: line(str(r?.from, 120), humanDate(r?.date), str(r?.snippet, 120)),
        })),
        fetchTool: 'gmail_read',
        fetchArgs: (recordId) => ({ messageId: recordId }),
        mapRecord: (raw) => ({
            title: str(raw?.subject, MAX_TITLE_LEN),
            subtitle: line(str(raw?.from, 120), humanDate(raw?.date)),
            // Headers first: a model asked "who wrote this" must not have
            // to infer it from the prose. The same headers also come back
            // structured, so a step can route on the sender without parsing.
            text: mailText(raw, ['body']),
            data: mailData(raw),
        }),
    },
    {
        id: 'outlook_message',
        appId: 'outlook',
        app: 'Outlook',
        label: 'Outlook email',
        searchHint: 'Search your Outlook mail',
        searchTool: 'outlook_search',
        searchArgs: (query, limit) => ({ query: query || 'a', maxResults: Math.min(limit, 20) }),
        mapResults: (raw) => resultRows(raw, 'results').map(r => ({
            id: str(r?.id, MAX_RECORD_ID_LEN),
            title: str(r?.subject, MAX_TITLE_LEN) || '(no subject)',
            subtitle: line(str(r?.from, 120), humanDate(r?.date), str(r?.snippet, 120)),
        })),
        fetchTool: 'outlook_read',
        fetchArgs: (recordId) => ({ messageId: recordId }),
        mapRecord: (raw) => ({
            title: str(raw?.subject, MAX_TITLE_LEN),
            subtitle: line(str(raw?.from, 120), humanDate(raw?.date)),
            text: mailText(raw, ['body', 'bodyPreview']),
            data: mailData(raw),
        }),
    },
    {
        id: 'drive_file',
        appId: 'google-drive',
        app: 'Google Drive',
        label: 'Google Drive file',
        searchHint: 'Search your Drive files by name',
        searchTool: 'drive_search',
        searchArgs: (query, limit) => ({ query: driveQuery(query), maxResults: limit }),
        mapResults: (raw) => resultRows(raw, 'results').map(r => ({
            id: str(r?.id, MAX_RECORD_ID_LEN),
            title: str(r?.name, MAX_TITLE_LEN) || 'Untitled',
            subtitle: line(humanDate(r?.modifiedTime), r?.size),
            url: str(r?.webViewLink, 500),
        })),
        // drive_get_content is the one that EXPORTS — a Doc as text, a Sheet as
        // CSV, a PDF through the extractor. drive_get_file would hand back
        // metadata a routine cannot read.
        fetchTool: 'drive_get_content',
        fetchArgs: (recordId) => ({ fileId: recordId }),
        mapRecord: (raw) => ({
            title: str(raw?.name ?? raw?.fileName, MAX_TITLE_LEN),
            subtitle: str(raw?.mimeType, MAX_SUBTITLE_LEN),
            url: str(raw?.webViewLink, 500),
            text: str(raw?.content ?? raw?.text ?? raw?.body, MAX_TEXT_CHARS),
            data: compact({
                name: str(raw?.name ?? raw?.fileName, 300),
                mimeType: str(raw?.mimeType, 200),
                modifiedTime: isoDate(raw?.modifiedTime),
                webViewLink: str(raw?.webViewLink, 500),
            }),
        }),
    },
];

const BY_ID = new Map(SOURCES.map(s => [s.id, s]));

/**
 * One example of each source's `data` object.
 *
 * Kept beside the registry (and pinned against the real mappers by
 * formPickSources.test.js) so the builder's preview and the runtime cannot
 * promise different keys.
 */
const SAMPLE_DATA = Object.freeze({
    fireflies_transcript: {
        date: '2026-09-01T10:00:00.000Z',
        durationMinutes: 45,
        organizer: 'anne@klant.nl',
        participants: ['anne@klant.nl', 'tom@bedrijf.nl'],
        speakers: ['Anne', 'Tom'],
        sentenceCount: 412,
    },
    meeting_note: {
        date: '2026-09-01T10:00:00.000Z',
        durationMinutes: 45,
        language: 'nl',
        summary: 'Wat er besproken is, in een paar alinea\'s.',
        speakers: ['Anne', 'Tom'],
        attendees: ['anne@klant.nl', 'tom@bedrijf.nl'],
        actionItems: ['Offerte opsturen voor vrijdag'],
        decisions: ['Fase 2 gaat door'],
        questions: ['Wie levert de data aan?'],
        tags: ['klant', 'offerte'],
    },
    gmail_message: {
        from: 'anne@klant.nl',
        to: 'tom@bedrijf.nl',
        subject: 'Offerte Q4',
        date: '2026-09-01T08:00:00.000Z',
        threadId: 'thr_123',
        hasAttachments: true,
        attachmentNames: ['offerte.pdf'],
    },
    outlook_message: {
        from: 'anne@klant.nl',
        to: 'tom@bedrijf.nl',
        subject: 'Offerte Q4',
        date: '2026-09-01T08:00:00.000Z',
        hasAttachments: false,
    },
    drive_file: {
        name: 'Offerte Q4.docx',
        mimeType: 'application/vnd.google-apps.document',
        modifiedTime: '2026-09-01T08:00:00.000Z',
        webViewLink: 'https://docs.google.com/document/d/abc',
    },
});

/** The source a field declares, or null. */
function getSource(id) {
    return BY_ID.get(String(id || '')) || null;
}

/** Every source id — the closed vocabulary validate.js checks a field against. */
const SOURCE_IDS = Object.freeze(SOURCES.map(s => s.id));

/**
 * What the AUTHOR may choose from, as the builder renders it. `id` is what goes
 * in the declaration; nothing else here is load-bearing.
 */
function catalog() {
    return SOURCES.map(s => ({
        id: s.id,
        appId: s.appId,
        app: s.app,
        label: s.label,
        searchHint: s.searchHint || '',
        internal: !!s.internal,
        // What `<field>.data` holds for THIS source, as an example value per
        // key. The builder's mapping panel renders it so an author can drag
        // `trigger.output.<field>.data.date` before a single form has been
        // submitted. Served rather than mirrored in the frontend: a sample
        // that promises a key the source does not produce is worse than no
        // sample, because the binding it creates resolves to undefined
        // forever and nothing says why.
        sampleData: SAMPLE_DATA[s.id] || {},
    }));
}

/**
 * The tool names a source may cause to run — what the route checks against the
 * FILLER's resolved tool set before it dispatches anything. An internal source
 * names none: it is answered by a store read under that store's own ACL.
 */
function toolsFor(source) {
    if (!source || source.internal) return [];
    return [source.searchTool, source.fetchTool].filter(Boolean);
}

/** Clamp a caller-supplied result count into the registry's range. */
function clampLimit(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_RESULTS;
    return Math.min(Math.max(Math.trunc(n), 1), MAX_RESULTS);
}

/** Clamp a caller-supplied query into a search term. */
function clampQuery(raw) {
    return typeof raw === 'string' ? raw.trim().slice(0, MAX_QUERY_LEN) : '';
}

/** How many records one field may collect, as declared. */
function clampMaxItems(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_MAX_PICKS;
    return Math.min(Math.max(Math.trunc(n), 1), MAX_PICKS);
}

/** Drop rows a mapper could not give an id to — an id is the whole point. */
function usableResults(rows) {
    const out = [];
    const seen = new Set();
    for (const r of Array.isArray(rows) ? rows : []) {
        if (!r?.id || seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({
            id: r.id,
            title: str(r.title, MAX_TITLE_LEN) || r.id,
            subtitle: str(r.subtitle, MAX_SUBTITLE_LEN),
            ...(r.url ? { url: str(r.url, 500) } : {}),
        });
        if (out.length >= MAX_RESULTS) break;
    }
    return out;
}

module.exports = {
    MAX_TEXT_CHARS,
    MAX_RESULTS,
    DEFAULT_RESULTS,
    MAX_QUERY_LEN,
    MAX_PICKS,
    DEFAULT_MAX_PICKS,
    MAX_RECORD_ID_LEN,
    MAX_TITLE_LEN,
    SOURCE_IDS,
    getSource,
    catalog,
    toolsFor,
    clampLimit,
    clampQuery,
    clampMaxItems,
    usableResults,
    // Exported for the resolver and its tests; not part of the field contract.
    humanDate,
    driveQuery,
    compact,
    isoDate,
    minutes,
    strList,
};
