/**
 * App Studio catalog — the v2 rich inputs: file and dataset upload, rich text,
 * datetime, relation, person and multiselect.
 */

'use strict';

const { LIMITS } = require('./limits');
const { VALUE_FROM } = require('./styleKnobs');

const RICH_INPUT_SPECS = {
    // ── v2 rich inputs ───────────────────────────────────────────────────
    input_file: {
        label: 'File upload', category: 'Input', isInput: true,
        description: 'A file picker. `accept` is a comma-separated MIME/extension list. `buttonLabel` renames the picker button itself — the runtime ships one English default, and a form your customers fill in should not say "Choose a file" in the middle of Dutch copy.',
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'file' },
            label: { type: 'string', required: true, maxLen: 120, default: 'File' },
            accept: { type: 'string', maxLen: 300, default: null },
            multiple: { type: 'boolean', default: false },
            required: { type: 'boolean', default: false },
            buttonLabel: { type: 'string', maxLen: 80, default: null },
        },
        // onChange fires once per upload batch, AFTER the descriptor lands. It
        // is what lets a form check a file the moment it arrives instead of at
        // the end — the seven-photo intake checks each photo on upload, locks
        // that one field with `readOnly` while its check runs, and leaves the
        // next field free. A text input has no onChange because it would fire
        // per keystroke; a file picker changes exactly once per pick.
        events: ['onChange'],
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 6 },
    },
    input_dataset: {
        label: 'Dataset upload', category: 'Input', isInput: true,
        description: 'Pick or upload a LARGE dataset (a multi-GB genome VCF). Uploads stream in resumable parts and index in the background, with progress shown; the ready dataset\'s descriptor becomes the form value — the shape dataset_query and the AI steps\' `datasets` binding take. Needs the large_datasets licence feature.',
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'dataset' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Genome file' },
            required: { type: 'boolean', default: false },
            buttonLabel: { type: 'string', maxLen: 80, default: null },
            // Let the viewer pick an already-ingested dataset instead of
            // uploading again — the normal case after the first visit.
            allowExisting: { type: 'boolean', default: true },
        },
        // Fires when a dataset becomes the selected value: on pick, and on
        // upload AFTER ingest reaches 'ready' (not on upload completion — a
        // dataset that is still indexing cannot be queried yet).
        events: ['onChange'],
        styleKnobs: ['span'],
        defaultStyle: { span: 12 },
    },
    input_richtext: {
        label: 'Rich text', category: 'Input', isInput: true,
        description: 'A rich-text (markdown) editor. Submits markdown.',
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'body' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Content' },
            required: { type: 'boolean', default: false },
            defaultValue: { type: 'markdown', maxLen: LIMITS.MAX_STRING, default: null },
            valueFrom: VALUE_FROM,
        },
        styleKnobs: ['span'],
        defaultStyle: { span: 12 },
    },
    /**
     * The other rich editor, and the reason there are two.
     *
     * `input_richtext` submits MARKDOWN, which is the right storage format for
     * a note that will be read back inside the app: it round-trips, it diffs,
     * and every markdown reader downstream keeps working. But markdown has no
     * colour, no typeface and no image — and an e-mail reply signed off with a
     * company logo needs all three. Converting the one into the other would
     * mean inventing markdown extensions nothing else can read.
     *
     * So this one submits HTML, aimed squarely at mail: inline styles only,
     * because that is what mail clients honour and what the outbound sanitizer
     * keeps. Anything pasted in is stripped to the same shape on the way in —
     * a Word paste drags in <style> blocks and class names that mean nothing
     * once the message leaves the building.
     */
    input_html: {
        label: 'Formatted text (HTML)', category: 'Input', isInput: true,
        description: 'A formatted-text editor that submits HTML — bold, italics, underline, lists, links, text colour, typeface, size and images. Use it for e-mail bodies and signatures; use input_richtext for notes stored in the app (that one submits markdown). Pair it with send_email bodyFormat "html".',
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'body' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Message' },
            required: { type: 'boolean', default: false },
            placeholder: { type: 'string', maxLen: 200, default: null },
            defaultValue: { type: 'string', maxLen: LIMITS.MAX_STRING, default: null },
            valueFrom: VALUE_FROM,
            // Editing a mail body in four lines is the complaint that starts
            // every "can we have a real editor" conversation.
            minRows: { type: 'int', min: 3, max: 30, default: 8 },
            // Off by default: an inline image is a base64 data URI in the
            // stored value, so a form that does not need one should not offer
            // a way to make every row heavy.
            allowImages: { type: 'boolean', default: false },
        },
        styleKnobs: ['span'],
        defaultStyle: { span: 12 },
    },
    input_datetime: {
        label: 'Date & time', category: 'Input', isInput: true,
        description: 'A date (optionally date+time) field. Submits ISO 8601.',
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'when' },
            label: { type: 'string', required: true, maxLen: 120, default: 'When' },
            required: { type: 'boolean', default: false },
            withTime: { type: 'boolean', default: true },
            defaultValue: { type: 'enum', values: [null, 'now', 'today'], default: null, allowIsoDate: true },
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 6 },
    },
    input_relation: {
        label: 'Relation', category: 'Input', isInput: true,
        description: 'Pick record(s) from a data table. `displayField` labels each option; `filter` is a formula that narrows the choices.',
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'related' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Related' },
            tableId: { type: 'string', maxLen: 60, default: null },
            displayField: { type: 'string', maxLen: 120, default: null },
            multiple: { type: 'boolean', default: false },
            required: { type: 'boolean', default: false },
            filter: { type: 'formula', default: null },
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 6 },
    },
    input_person: {
        label: 'Person', category: 'Input', isInput: true,
        description: 'Pick a member of the organisation. Submits their user id, so "assigned to me" can compare against currentUser.id. ALSO publishes <name>_label with the display name — write both, because there are no joins to look the name up later. Needs model.directory.orgMembers = true.',
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'person' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Person' },
            multiple: { type: 'boolean', default: false },
            required: { type: 'boolean', default: false },
            allowMe: { type: 'boolean', default: true },
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 6 },
    },
    input_multiselect: {
        label: 'Multi-select', category: 'Input', isInput: true,
        description: 'A dropdown that accepts multiple fixed options. Submits an array of values.',
        events: ['onChange'],
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'choices' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Choices' },
            options: {
                type: 'list', maxItems: LIMITS.MAX_SELECT_OPTIONS, default: [],
                itemShape: { value: { type: 'string', required: true, maxLen: 200 }, label: { type: 'string', maxLen: 200 } },
            },
            required: { type: 'boolean', default: false },
            defaultValue: { type: 'stringList', maxItems: LIMITS.MAX_SELECT_OPTIONS, itemMaxLen: 200, default: [] },
            valueFrom: VALUE_FROM,
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 6 },
    },
};

module.exports = {
    RICH_INPUT_SPECS,
};
