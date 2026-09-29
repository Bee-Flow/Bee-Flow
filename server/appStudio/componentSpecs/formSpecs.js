/**
 * App Studio catalog — the card shell, the form, and the core inputs the v1
 * catalog shipped with (text, textarea, number, select, checkbox, date).
 */

'use strict';

const { LIMITS } = require('./limits');
const { VALUE_FROM } = require('./styleKnobs');

const FORM_SPECS = {
    card: {
        label: 'Card', category: 'Layout',
        description: 'A surface that groups other components. Children lay out on the card’s own 12-column grid.',
        container: true,
        props: {
            title: { type: 'string', maxLen: 120, default: null },
            description: { type: 'string', maxLen: 300, default: null },
            // Look pass. The card is the most-placed surface in generated
            // apps, so one knob here changes an app's character the most.
            look: {
                type: 'enum', values: ['default', 'flat', 'raised', 'tinted', 'accent', 'gradient', 'solid'], default: 'default',
                description: 'default = the current card surface; flat = flush and borderless; raised = shadow elevation; tinted = soft primary wash; accent = a primary edge bar; gradient = soft primary gradient surface; solid = filled with the primary colour, contents in its contrast colour (title colour: heading color knob).',
            },
        },
        styleKnobs: ['span', 'padding', 'gap', 'radius', 'background', 'height', 'border'],
        defaultStyle: { span: 6, padding: 3, gap: 3, background: 'surface' },
    },
    form: {
        label: 'Form', category: 'Input',
        description: 'Groups inputs and submits them to an action. Renders one built-in submit button; set showSubmit false for a form whose fields save on change.',
        container: true,
        events: ['onSubmit'],
        props: {
            name: { type: 'string', maxLen: 60, default: null },   // canonicalize fills frm_<id>
            submitLabel: { type: 'string', maxLen: 80, default: 'Submit' },
            showReset: { type: 'boolean', default: false },
            // A triage bar whose selects save on change still rendered a Save
            // button, because a form always did. A primary button that does
            // nothing is the loudest possible signal that a screen is generated
            // rather than designed.
            showSubmit: { type: 'boolean', default: true },
            // A form that EDITS a selected record. When this formula's value
            // changes (the selected row's id, typically) the form starts over:
            // every field back to its default, every valueFrom read afresh.
            // Without it a field kept the previous row's value whenever the
            // new row's was empty — valueFrom never pushes null on purpose —
            // and Save then wrote one record's thickness onto another.
            resetKey: { type: 'formula', default: null },
        },
        // A form is a region like any other container, but it was the one that
        // could not be given an edge or a ground — so a composer or a filled-in
        // panel had to be wrapped in a card to look like anything. Inside a
        // tab that wrapper costs a nesting level, and at MAX_DEPTH there is
        // none to spend: the form then stays visually flat with no way out.
        // The defaults keep every existing form byte-identical.
        styleKnobs: ['span', 'gap', 'padding', 'background', 'radius', 'border'],
        defaultStyle: { span: 6, gap: 3, padding: 0 },
    },
    input_text: {
        label: 'Text input', category: 'Input', isInput: true,
        description: 'A single-line text field.',
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'field' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Text' },
            placeholder: { type: 'string', maxLen: 200, default: null },
            required: { type: 'boolean', default: false },
            defaultValue: { type: 'string', maxLen: 1000, default: null },
            inputType: { type: 'enum', values: ['text', 'email', 'url'], default: 'text' },
            valueFrom: VALUE_FROM,
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 12 },
    },
    input_textarea: {
        label: 'Text area', category: 'Input', isInput: true,
        description: 'A multi-line text field. Bind snippets to a table of saved texts and typing "/" offers them inline (snippetKey = the shortcut column, snippetBody = the text to insert).',
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'message' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Message' },
            placeholder: { type: 'string', maxLen: 200, default: null },
            required: { type: 'boolean', default: false },
            rows: { type: 'int', min: 2, max: 10, default: 4 },
            valueFrom: VALUE_FROM,
            // Slash-snippets. A saved-reply table is only useful if it is
            // reachable while typing; a modal picker three clicks away is not
            // what anyone means by "shortcut".
            snippets: { type: 'binding', default: { kind: 'static', value: null } },
            snippetKey: { type: 'string', maxLen: 60, default: 'shortcut' },
            snippetBody: { type: 'string', maxLen: 60, default: 'body' },
            snippetLabel: { type: 'string', maxLen: 60, default: 'title' },
        },
        styleKnobs: ['span'],
        defaultStyle: { span: 12 },
    },
    input_number: {
        label: 'Number input', category: 'Input', isInput: true,
        description: 'A numeric field with optional min/max.',
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'amount' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Amount' },
            min: { type: 'number', default: null },
            max: { type: 'number', default: null },
            step: { type: 'number', default: 1 },
            required: { type: 'boolean', default: false },
            defaultValue: { type: 'number', default: null },
            // Text and select could show the value the record already has;
            // a number could not — so a panel for correcting a thickness had
            // to open on an empty box next to the value it was correcting.
            valueFrom: VALUE_FROM,
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 6 },
    },
    input_select: {
        label: 'Select', category: 'Input', isInput: true,
        description: 'A dropdown with fixed options.',
        events: ['onChange'],
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'choice' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Choice' },
            options: {
                type: 'list', maxItems: LIMITS.MAX_SELECT_OPTIONS, default: [],
                itemShape: { value: { type: 'string', required: true, maxLen: 200 }, label: { type: 'string', maxLen: 200 } },
            },
            required: { type: 'boolean', default: false },
            defaultValue: { type: 'string', maxLen: 200, default: null },
            placeholder: { type: 'string', maxLen: 120, default: null },
            // Show the value the record ALREADY has. Without it a triage bar is
            // write-only: it can set a status but never tell you the current
            // one, so every screen using it was lying by omission.
            valueFrom: VALUE_FROM,
            // Options from a TABLE. A materials list, a set of cost centres, a
            // list of sites — the choices people pick from are rows somebody
            // maintains, not a list an author retypes into every select. Rows
            // become options through optionValueKey/optionLabelKey; the fixed
            // `options` above still render first, so a "(none)" entry can sit
            // ahead of the table.
            optionsFrom: { type: 'binding', default: null },
            optionValueKey: { type: 'string', maxLen: 120, default: null },
            optionLabelKey: { type: 'string', maxLen: 120, default: null },
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 6 },
    },
    input_checkbox: {
        label: 'Checkbox', category: 'Input', isInput: true,
        description: 'A single yes/no checkbox.',
        events: ['onChange'],
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'agree' },
            label: { type: 'string', required: true, maxLen: 200, default: 'Yes' },
            defaultChecked: { type: 'boolean', default: false },
        },
        styleKnobs: ['span'],
        defaultStyle: { span: 12 },
    },
    input_date: {
        label: 'Date picker', category: 'Input', isInput: true,
        description: 'A date field. Submits ISO YYYY-MM-DD.',
        events: ['onChange'],
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'date' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Date' },
            required: { type: 'boolean', default: false },
            defaultValue: { type: 'enum', values: [null, 'today'], default: null, allowIsoDate: true },
            valueFrom: VALUE_FROM,
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 6 },
    },
};

module.exports = {
    FORM_SPECS,
};
