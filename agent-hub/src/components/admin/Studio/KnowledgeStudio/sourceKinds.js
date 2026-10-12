/**
 * sourceKinds — the eight kinds of knowledge source, as the UI says them
 * (Knowledge artboard 1a, plan K1/K2).
 *
 * ── WHY ALL EIGHT ARE HERE WHEN SEVEN WORK ──────────────────────────
 * The server creates `text`, `upload`, `webpage`, `meeting_tag` (K7) and
 * `datatable` (K8) today; `automation` works as of K10 but is never CREATED
 * here (see SIGNPOST_KINDS below); `nextcloud_folder` arrives with K9, and
 * `legacy` is what the backfill migration gives pre-existing documents. The
 * artboard draws all seven buttons and the plan is explicit: the unbuilt
 * ones are DISABLED WITH A TOOLTIP, not hidden.
 *
 * That is not a stylistic preference. A person who cannot see that "Tabel"
 * is coming concludes the product cannot do it and goes and builds a CSV
 * export instead; a person who sees it greyed with "komt binnenkort" waits
 * a release. And the reverse — a button that 400s with `kind_not_available`
 * — teaches that the product is broken rather than unfinished. So the list
 * is complete and `CREATABLE_KINDS` is the gate, mirroring the server's own
 * export of the same name.
 *
 * A `legacy` source cannot be created at all and has no button: it is a
 * label for rows that predate the source model.
 *
 * ── COLOUR COMES FROM kindColors, NOT FROM HERE ─────────────────────
 * A source's tile borrows the colour of the OBJECT it points at — a table
 * source is `--type-data` because a table is, a meeting source is
 * `--kind-meet` — so the person who learned the legend on the Studio rail
 * reads this table without a second one. `tint: null` means the neutral
 * `--bg-tertiary` tile the artboard draws for uploads, text and folders:
 * a file is not one of Studio's kinds and giving it a borrowed colour would
 * claim a relationship it does not have.
 */
import { FileText, Folder, Globe, Mic, Table, Upload, Workflow } from 'lucide-react';
import { pluralKey } from './plural';

/** Kinds `POST /api/kb/:id/sources` accepts today (server: sources#CREATABLE_KINDS). */
export const CREATABLE_KINDS = Object.freeze(['text', 'upload', 'webpage', 'meeting_tag', 'datatable']);

/**
 * The seven buttons of the "Bron toevoegen" card, in the artboard's own
 * order (2-column grid; `automation` spans both columns and is a HINT, not
 * a form — an automation source appears when an automation writes to this KB).
 */
export const ADD_SOURCE_KINDS = Object.freeze([
    'nextcloud_folder', 'upload', 'datatable', 'meeting_tag', 'webpage', 'text', 'automation',
]);

const KINDS = Object.freeze({
    nextcloud_folder: {
        icon: Folder, tint: null,
        labelKey: 'knowledge.kind.nextcloud_folder', labelFallback: 'Folder in Nextcloud',
        track: 'K9',
    },
    upload: {
        icon: Upload, tint: null,
        labelKey: 'knowledge.kind.upload', labelFallback: 'Upload files',
    },
    datatable: {
        icon: Table, tint: 'datatable',
        labelKey: 'knowledge.kind.datatable', labelFallback: 'Table',
    },
    meeting_tag: {
        icon: Mic, tint: 'meeting',
        labelKey: 'knowledge.kind.meeting_tag', labelFallback: 'Meeting notes',
    },
    webpage: {
        icon: Globe, tint: 'webpage',
        labelKey: 'knowledge.kind.webpage', labelFallback: 'Web page / URL',
    },
    text: {
        icon: FileText, tint: null,
        labelKey: 'knowledge.kind.text', labelFallback: 'Paste text',
    },
    automation: {
        icon: Workflow, tint: 'automation',
        labelKey: 'knowledge.kind.automation', labelFallback: 'Let an automation fill it',
    },
    legacy: {
        icon: FileText, tint: null,
        labelKey: 'knowledge.kind.legacy', labelFallback: 'Imported',
    },
});

const FALLBACK = Object.freeze({ icon: FileText, tint: null, labelKey: 'knowledge.kind.legacy', labelFallback: 'Imported' });

/** The descriptor for a kind; an unknown kind reads as `legacy` rather than crashing. */
export function sourceKind(kind) {
    return KINDS[kind] || FALLBACK;
}

/** Can this kind be created right now? */
export function isCreatable(kind) {
    return CREATABLE_KINDS.includes(kind);
}

/**
 * Kinds whose button opens an EXPLANATION rather than a form.
 *
 * `automation` is not creatable and never will be: a source of that kind
 * appears because an automation writes to this base, which is a thing you do in
 * the automation, not here. But it is not "coming soon" either — it works, as of
 * K10 — so the button has to be reachable and say where to go. A third state,
 * because the other two would both be lies.
 */
export const SIGNPOST_KINDS = Object.freeze(['automation']);

/** Is this kind's button live at all — either a form, or a signpost? */
export function isOfferable(kind) {
    return isCreatable(kind) || SIGNPOST_KINDS.includes(kind);
}

/**
 * The row's SECOND line — what this source actually is, in its own terms.
 * The artboard writes a different sentence per kind ("map · 38 bestanden",
 * "kolommen A, B, C · 212 rijen", "geplakte tekst · door Tessa"), because
 * "5 documenten" repeated five times tells the reader nothing about which
 * row to click.
 *
 * Returns `{ key, params }` for t(). `config` is the server's per-kind
 * ALLOW-LIST (K1b), so nothing here can read a field the server did not
 * mean to publish — a text source's own text, in particular, never leaves
 * the server, which is why the text subline counts characters instead.
 */
export function sublineFor(source = {}) {
    const kind = source.kind;
    const config = source.config || {};
    const docs = Number(source.documentCount) || 0;
    switch (kind) {
        case 'nextcloud_folder':
            return { key: pluralKey('knowledge.subline.folder', docs), params: { count: docs } };
        case 'upload':
            return { key: pluralKey('knowledge.subline.upload', docs), params: { count: docs } };
        case 'datatable':
            /**
             * `docs` is DOCUMENTS, and for a big table one document holds a
             * block of rows — so "212 rows" would be a lie on exactly the
             * tables where the number matters. The stored row count is the
             * table's own; the document count is what this base holds.
             */
            return {
                key: pluralKey(config.columns?.length ? 'knowledge.subline.datatable_columns' : 'knowledge.subline.datatable', docs),
                params: {
                    columns: (config.columns || []).join(', '),
                    count: docs,
                    table: config.tableName || '',
                },
            };
        case 'meeting_tag':
            /**
             * What is actually in it, from the fields the source stores.
             *
             * This used to read `config.mode === 'summary' ? … : 'full
             * transcripts'`, and "full transcripts" was never reachable —
             * K7 does not offer a transcript at all, deliberately: it is the
             * raw record of who said what, and it is full of asides nobody
             * meant to publish. Leaving that branch would have promised
             * something the source cannot contain.
             */
            return {
                key: pluralKey('knowledge.subline.meeting', docs),
                params: {
                    count: docs,
                    tag: config.tag || '',
                    fieldKeys: Array.isArray(config.fields) && config.fields.length
                        ? config.fields
                        : ['summary', 'decisions'],
                },
            };
        case 'webpage':
            return {
                key: pluralKey(config.crawl ? 'knowledge.subline.webpage_site' : 'knowledge.subline.webpage', docs || 1),
                params: { count: docs || 1 },
            };
        case 'text':
            // No count: a text source is one pasted snippet, and who pasted
            // it is the thing that tells rows apart.
            return { key: 'knowledge.subline.text', params: { by: source.createdBy?.name || '' } };
        case 'automation':
            return { key: pluralKey('knowledge.subline.automation', docs), params: { count: docs } };
        default:
            return { key: pluralKey('knowledge.subline.legacy', docs), params: { count: docs, type: config.sourceType || '' } };
    }
}
