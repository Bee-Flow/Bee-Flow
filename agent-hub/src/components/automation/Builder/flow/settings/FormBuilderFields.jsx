import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Eye } from 'lucide-react';
import { FormRow, inputClass, textareaClass, denseInputClass, cardClass, subLabelClass } from './formPrimitives';
import PublicFormRenderer, { FormEndingView } from '../../../../forms/PublicFormRenderer';
import TemplateField from '../../mapping/TemplateField';
import { loadPickSources, pickSourcesSync } from '../pickSourceCatalog';
// The binding name and its rename live in the shared field designer — the
// parameter-row editors declare names too, and two copies of that box is two
// chances to ship an edit that moves a binding without moving what points at
// it (see fieldDesigner.jsx).
import { BindingNameField } from './fieldDesigner';
import { walkPath, previewValue } from '../../../../../utils/bindingHelpers';
import { normaliseOptions } from '../../../../forms/formOptions';
import { useTranslation } from '../../../../../hooks/useTranslation';

export { normaliseOptions };

/**
 * The shared editor for ONE hosted form page — used by the form trigger (page
 * one) and by every `form_page` step (page two onwards, and the closing page).
 * All three declare the same `form` object, so they get the same surface.
 *
 * Three ideas the whole panel is built around:
 *
 *   1. Dropping a node already gives a WORKING page (title, fields, thank-you
 *      text, the Clean preset). Refining is optional, not a prerequisite —
 *      that is what "super simpel in gebruik" has to mean.
 *   2. Styling is a set of presets plus five knobs. No CSS, ever. The knobs are
 *      the platform's shared THEME_SPEC (server/core/themeSpec.js), so a form
 *      and a Studio App are themed by the same vocabulary.
 *   3. The author edits the LABEL; `name` is slugged once at creation and never
 *      re-derived. Re-deriving on every rename would silently break every
 *      `<base>.<name>` binding downstream, with no error anywhere.
 *
 * Props:
 *   form        — the declaration being edited
 *   onChange(next) — receives the WHOLE next declaration
 *   bindingBase — 'trigger.output' or 'steps.<id>.output'; shown read-only per
 *                 field so an author can see what to bind downstream
 *   variant     — 'input' (a page with questions) or 'ending' (a closing page:
 *                 text only, no questions, no submit button)
 *   allowVariables — offer the {} picker on every text slot, so the page can
 *                 greet the visitor by name or summarise what the automation did.
 *                 OFF for the trigger: page one is rendered before anything has
 *                 run, and the server passes it no interpolator, so a `{{…}}`
 *                 there would reach the visitor verbatim.
 *   onFocusField / previewSample — the usual mapping plumbing, so clicking or
 *                 dragging a value in the Input panel lands in the focused slot
 */

const FIELD_TYPES = [
    { value: 'text', label: 'Short text' },
    { value: 'textarea', label: 'Long text' },
    { value: 'email', label: 'Email' },
    { value: 'number', label: 'Number' },
    { value: 'date', label: 'Date' },
    { value: 'select', label: 'Dropdown' },
    { value: 'checkbox', label: 'Checkbox' },
    { value: 'file', label: 'File upload' },
    { value: 'app_pick', label: 'Pick from an app' },
    { value: 'download', label: 'Download button' },
    { value: 'notebook', label: 'Open in Notebooks' },
];

/**
 * The apps an "Pick from an app" question can offer. The list itself lives in
 * flow/pickSourceCatalog.js, which the mapping panel reads too — see the note
 * there for why there is exactly one copy of it in the frontend.
 */
function usePickSources() {
    const [sources, setSources] = useState(pickSourcesSync());
    useEffect(() => {
        let live = true;
        loadPickSources().then(list => { if (live) setSources(list); });
        return () => { live = false; };
    }, []);
    return sources;
}

/**
 * Field types that GIVE instead of ask. They collect nothing, so they are
 * never submitted, never required, and have no placeholder or binding name.
 * Mirrors DISPLAY_FIELD_TYPES on the server (automation/formTriggerContract.js)
 * and in the renderer (components/forms/PublicFormRenderer.jsx).
 */
const DISPLAY_FIELD_TYPES = ['download', 'notebook'];
const isDisplayField = (f) => DISPLAY_FIELD_TYPES.includes(f?.type);

// One click sets all five theme keys. This IS the "styling without code" story;
// the individual knobs below are for the people who want to fine-tune.
export const THEME_PRESETS = [
    { id: 'clean', label: 'Clean', theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'light' } },
    { id: 'corporate', label: 'Corporate', theme: { primary: '#1D4ED8', radius: 'sm', density: 'compact', fontScale: 'sm', appearance: 'light' } },
    { id: 'friendly', label: 'Friendly', theme: { primary: '#C2410C', radius: 'xl', density: 'spacious', fontScale: 'lg', appearance: 'light' } },
    { id: 'night', label: 'Night', theme: { primary: '#0891B2', radius: 'lg', density: 'comfortable', fontScale: 'md', appearance: 'dark' } },
    { id: 'system', label: 'Match visitor', theme: { primary: '#047857', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' } },
];

const THEME_KNOBS = [
    { key: 'radius', label: 'Corners', values: ['none', 'sm', 'md', 'lg', 'xl'] },
    { key: 'density', label: 'Spacing', values: ['compact', 'comfortable', 'spacious'] },
    { key: 'fontScale', label: 'Text size', values: ['sm', 'md', 'lg'] },
    { key: 'appearance', label: 'Appearance', values: ['light', 'dark', 'auto'] },
];

const COLOR_PRESETS = [
    '#0F766E', '#0369A1', '#1D4ED8', '#0891B2', '#047857', '#4D7C0F',
    '#B45309', '#C2410C', '#B91C1C', '#BE185D', '#334155', '#57534E',
];

/** The form a freshly-dropped trigger node starts with — already publishable. */
export function defaultFormDeclaration() {
    return {
        title: 'Get in touch',
        description: '',
        submitLabel: 'Submit',
        successMessage: 'Thanks — we got your answer.',
        fields: [
            { name: 'name', type: 'text', label: 'Your name', required: true, placeholder: '' },
            { name: 'email', type: 'email', label: 'Your email', required: true, placeholder: '' },
            { name: 'message', type: 'textarea', label: 'How can we help?', required: false, placeholder: '' },
        ],
        theme: { ...THEME_PRESETS[0].theme },
    };
}

/**
 * A mid-flow page asking for one more thing. `theme: null` means "inherit the
 * trigger's" — the server merges it, so pages match without the author having
 * to restyle each one.
 */
export function defaultFormPageDeclaration() {
    return {
        title: 'One more thing',
        description: '',
        submitLabel: 'Continue',
        successMessage: 'Thanks!',
        fields: [{ name: 'answer', type: 'text', label: 'Your answer', required: true, placeholder: '' }],
        theme: null,
    };
}

/** The closing page. No questions — its job is to tell the visitor what happened. */
export function defaultFormEndingDeclaration() {
    return {
        title: 'All done',
        description: 'Thanks — here is what we did:\n',
        fields: [],
        theme: null,
    };
}

/**
 * Label → field name, once. Must produce a valid identifier for the server's
 * PARAM_NAME_RE (letter first, then letters/digits/underscore).
 */
export function slugifyFieldName(label, taken = new Set()) {
    const base = String(label || '')
        .normalize('NFKD')
        .replace(/[^\w\s]/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[^a-z]+/, '')
        .slice(0, 55) || 'field';
    if (!taken.has(base)) return base;
    for (let i = 2; i < 200; i += 1) {
        const candidate = `${base}_${i}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `${base}_${Date.now().toString(36)}`;
}

/**
 * Resolve `{{path}}` against the builder's sample tree for the preview only.
 * Unresolvable paths are left standing — a typo should stay visible instead of
 * quietly turning into an empty string.
 */
export function fillTemplate(text, sampleRoot) {
    const s = String(text ?? '');
    if (!s || !sampleRoot || !/\{\{[^}]+\}\}/.test(s)) return s;
    return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, expr) => {
        const v = walkPath(expr.trim(), sampleRoot);
        return v === undefined ? full : previewValue(v, 40);
    });
}

/**
 * The stored options array as the "one per line" text the author edits.
 *
 * The blank filter is deliberate: an AI-authored `{ label: 'B' }` with no
 * `value` yields '' here, and showing it would put an empty line in the middle
 * of the list. It stays invisible, exactly as it is today.
 */
const joinOptions = (options) => (options || [])
    .map(o => (typeof o === 'string' ? o : o?.value || ''))
    .filter(Boolean)
    .join('\n');

/** The reverse: the text the author typed as the array we persist. */
const splitOptions = (text) => text.split('\n').map(s => s.trim()).filter(Boolean);

export default function FormBuilderFields({
    form,
    onChange,
    bindingBase = 'trigger.output',
    variant = 'input',
    allowVariables = false,
    onFocusField = null,
    previewSample = null,
    // (answers) => Promise. When present the preview below stops being a
    // picture and becomes an inline TEST of the trigger: filling it in and
    // pressing the submit button sends those answers as the run's
    // triggerPayload, so the steps after the trigger can be built against real
    // shapes without publishing anything (BFSF-408a). Default null — the same
    // component renders a `form_page` step's preview, where it must stay inert.
    onTestSubmit = null,
    // (from, to) => number|undefined. Renames a question's BINDING NAME and
    // rewrites every step that points at it, in one edit — see
    // BindingNameField. Supplied only where the whole automation is in scope (the
    // builder); null in the standalone Forms editor, which can see the form but
    // not the steps that bind it, and where the name is therefore read-only.
    onRenameField = null,
}) {
    const { t } = useTranslation();
    // Default OPEN when this is the trigger's own testable editor
    // (onTestSubmit present) — BFSF-408, reopened. A tester following "hit
    // play, see a form" never found the preview when it started collapsed
    // behind a small text link after Theme settings; there was nothing wrong
    // with the preview itself, only its discoverability. A `form_page` step's
    // look-see (onTestSubmit null — nothing to submit there) keeps the old
    // collapsed default; it is a picture, not a test.
    const [showPreview, setShowPreview] = useState(!!onTestSubmit);
    const fields = useMemo(() => (Array.isArray(form?.fields) ? form.fields : []), [form]);
    const isEnding = variant === 'ending';
    // Keep the real index: the card edits `fields[i]`, and a filtered list
    // would renumber and edit the wrong row.
    const displayFields = useMemo(
        () => fields.map((field, index) => ({ field, index })).filter(({ field }) => isDisplayField(field)),
        [fields],
    );
    // `null` is the inherit-from-the-trigger signal; the editor still needs
    // concrete values to render its own controls against.
    const theme = form?.theme || THEME_PRESETS[0].theme;
    const inherits = !form?.theme;

    // The preview is the visitor's view, and the visitor never sees `{{…}}` —
    // the server interpolates at the moment the page is shown. So resolve the
    // same way here, against the sample tree, and leave unresolvable paths
    // standing so a typo stays visible rather than silently vanishing.
    const previewConfig = useMemo(() => {
        const fill = allowVariables ? (s) => fillTemplate(s, previewSample) : (s) => s;
        return {
            title: fill(form?.title) || (isEnding ? 'All done' : 'Form'),
            description: fill(form?.description) || '',
            submitLabel: fill(form?.submitLabel) || 'Submit',
            successMessage: fill(form?.successMessage) || 'Thanks!',
            theme,
            fields: fields.filter(f => f?.name).map(f => ({
                ...f,
                label: fill(f.label),
                placeholder: fill(f.placeholder),
                maxSizeMb: f.maxSizeMb || 10,
                options: normaliseOptions(f.options),
                // The real filename and size come from the ledger at serve
                // time, so the preview stands in for them — a button labelled
                // only "Download" tells the author nothing about the shape.
                ...(isDisplayField(f) ? { filename: 'document.pdf', size: 182_000 } : {}),
            })),
        };
    }, [form, fields, theme, isEnding, allowVariables, previewSample]);

    const patch = (changes) => onChange({ ...form, ...changes });
    const setFields = (next) => patch({ fields: next });

    const addField = () => {
        const taken = new Set(fields.map(f => f.name));
        const label = 'New question';
        setFields([...fields, { name: slugifyFieldName(label, taken), type: 'text', label, required: false, placeholder: '' }]);
    };
    const addFileField = (type) => {
        const taken = new Set(fields.map(f => f.name));
        const label = type === 'notebook' ? 'Open in Notebooks' : 'Download';
        setFields([...fields, { name: slugifyFieldName(label, taken), type, label, fileId: '' }]);
    };
    const updateField = (i, changes) => setFields(fields.map((f, j) => (j === i ? { ...f, ...changes } : f)));
    const removeField = (i) => setFields(fields.filter((_, j) => j !== i));
    const moveField = (i, dir) => {
        const j = i + dir;
        if (j < 0 || j >= fields.length) return;
        const next = fields.slice();
        [next[i], next[j]] = [next[j], next[i]];
        setFields(next);
    };

    /**
     * One text slot. With variables allowed it is a TemplateField — the {}
     * button, the Input-panel drag target and the resolved example line all
     * come with it, so a page reads the same way as a Notification body.
     *
     * A plain function, deliberately NOT a component: declaring a component
     * inside the body gives it a new type on every render, so React would
     * remount the field on each keystroke and the caret would jump out.
     */
    const textSlot = ({ slot, rows = 1, ariaLabel = null, placeholder = '' }) => (
        allowVariables ? (
            <TemplateField
                value={form[slot] || ''}
                onChange={(next) => patch({ [slot]: next })}
                rows={rows}
                multiline={rows > 1}
                inline={rows === 1}
                ariaLabel={ariaLabel}
                onFocusField={onFocusField}
                previewSample={previewSample}
                placeholder={placeholder}
                listAs="markdown"
            />
        ) : rows > 1 ? (
            <textarea rows={rows} aria-label={ariaLabel || undefined} value={form[slot] || ''} onChange={(e) => patch({ [slot]: e.target.value })} className={textareaClass()} placeholder={placeholder} />
        ) : (
            <input type="text" aria-label={ariaLabel || undefined} value={form[slot] || ''} onChange={(e) => patch({ [slot]: e.target.value })} className={inputClass()} placeholder={placeholder} />
        )
    );

    const varsHint = allowVariables
        ? ' Drag a value from the Input panel (or use the {} button) to drop in something from an earlier step.'
        : '';

    // The live preview, once. Two very different presentations of the SAME
    // toggle + panel:
    //
    //   onTestSubmit present (the trigger's own editor) — a bordered, titled
    //   card with real visual weight, because this is the answer to "hit
    //   play, see the form" (BFSF-408, reopened): a tester following that
    //   never found it as a small text link after Theme settings.
    //   onTestSubmit null (a form_page step's look-see) — the original small
    //   text link, unchanged, because there is nothing here to TEST — no
    //   trigger to fire, just a picture of a later page.
    //
    // The toggle label stays IDENTICAL in both cases ("Preview the form" /
    // "Hide preview") — only the surrounding weight differs — so no caller
    // that reads for that text needs to know which mode it is looking at.
    const previewSection = (
        <div className={onTestSubmit ? 'rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] p-3 space-y-2' : ''}>
            {onTestSubmit && (
                <div className="text-[11px] text-[var(--text-secondary)] leading-snug">
                    <span className="font-semibold text-[var(--text-primary)]">{t('automations.form_builder_fields.test_this_form', 'Test this form.')}</span>{' '}
                    {t('automations.form_builder_fields.fill_it_in_below_and_press', 'Fill it in below and press its Submit button to send a real test through this automation — nothing goes live, and no visitor sees it.')}
                </div>
            )}
            <button
                type="button"
                onClick={() => setShowPreview(v => !v)}
                className={onTestSubmit
                    ? 'flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent)] hover:opacity-80 px-1 py-0.5 rounded transition'
                    : 'flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-1 py-0.5 rounded transition'}
            >
                <Eye size={onTestSubmit ? 13 : 12} /> {showPreview ? 'Hide preview' : 'Preview the form'}
            </button>
            {showPreview && (
                <div className="mt-2 p-3 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)]" data-testid="form-preview">
                    {/* The same component the visitor gets — inert unless
                        the host handed us a way to run the trigger with
                        what is typed into it. `showSuccess` stays off for a
                        test run: swapping the form for its thank-you page
                        would take away the thing being tested. */}
                    {isEnding
                        ? <FormEndingView form={previewConfig} />
                        : <PublicFormRenderer
                            form={previewConfig}
                            preview={!onTestSubmit}
                            onSubmit={onTestSubmit}
                            showSuccess={false}
                        />}
                </div>
            )}
        </div>
    );

    return (
        <div className="space-y-3">
            <FormRow label={isEnding ? 'Heading' : 'Form title'} hint={allowVariables ? varsHint.trim() : null}>
                {textSlot({ slot: 'title', placeholder: isEnding ? 'All done' : 'Get in touch' })}
            </FormRow>
            <FormRow
                label={isEnding ? 'Message' : 'Intro text'}
                hint={isEnding
                    ? `Tell the visitor what happened.${varsHint || ' Use {{steps.…}} to show what the automation did — it is filled in when the page is shown.'}`
                    : `Shown under the title. Optional.${varsHint}`}
            >
                {textSlot({ slot: 'description', rows: isEnding ? 4 : 2 })}
            </FormRow>

            {/* Near the TOP of the panel, not buried after Theme settings —
                only for the trigger's own testable editor. A form_page's
                inert look-see stays where it always was, below. */}
            {onTestSubmit && previewSection}

            {!isEnding && (
                <>
                    <div className="space-y-1.5">
                        <div className={subLabelClass()}>{t('automations.form_builder_fields.questions', 'Questions')}</div>
                        {fields.length === 0 && (
                            <div className="text-[11px] text-[var(--text-tertiary)] italic">{t('automations.form_builder_fields.no_questions_yet_nobody_can_submit', 'No questions yet — nobody can submit this form.')}</div>
                        )}
                        {fields.map((field, i) => (
                            <FieldCard
                                key={i}
                                field={field}
                                index={i}
                                count={fields.length}
                                bindingBase={bindingBase}
                                allowVariables={allowVariables}
                                onFocusField={onFocusField}
                                previewSample={previewSample}
                                siblings={fields}
                                onRenameField={onRenameField}
                                onChange={(changes) => updateField(i, changes)}
                                onRemove={() => removeField(i)}
                                onMove={(dir) => moveField(i, dir)}
                            />
                        ))}
                        <button
                            type="button"
                            onClick={addField}
                            className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] px-2 py-1 rounded transition"
                        >
                            <Plus size={12} /> {t('automations.form_builder_fields.add_a_question', 'Add a question')}
                        </button>
                    </div>

                    <FormRow label={t('automations.form_builder_fields.button_text', 'Button text')}>
                        {textSlot({ slot: 'submitLabel', placeholder: 'Submit' })}
                    </FormRow>
                    <FormRow label={t('automations.form_builder_fields.thank_you_message', 'Thank-you message')} hint={`Replaces the form after a successful submission.${varsHint}`}>
                        {textSlot({ slot: 'successMessage', rows: 2 })}
                    </FormRow>
                </>
            )}

            {/* A closing page asks nothing, so it has no Questions block — but
                it IS where a document the automation just made should land. Only
                display fields are offered here; anything that collected input
                would have no way to be submitted. */}
            {isEnding && (
                <div className="space-y-1.5">
                    <div className={subLabelClass()}>{t('automations.form_builder_fields.downloads', 'Downloads')}</div>
                    {displayFields.length === 0 && (
                        <div className="text-[11px] text-[var(--text-tertiary)] italic">
                            {t('automations.form_builder_fields.nothing_to_hand_over_offer_a', 'Nothing to hand over — offer a file the automation made, to save or to open in Notebooks.')}
                        </div>
                    )}
                    {displayFields.map(({ field, index }) => (
                        <FieldCard
                            key={index}
                            field={field}
                            index={index}
                            count={fields.length}
                            bindingBase={bindingBase}
                            allowVariables={allowVariables}
                            onFocusField={onFocusField}
                            previewSample={previewSample}
                            siblings={fields}
                            onRenameField={onRenameField}
                            onChange={(changes) => updateField(index, changes)}
                            onRemove={() => removeField(index)}
                            onMove={(dir) => moveField(index, dir)}
                        />
                    ))}
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={() => addFileField('download')}
                            className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] px-2 py-1 rounded transition"
                        >
                            <Plus size={12} /> {t('automations.form_builder_fields.add_a_download', 'Add a download')}
                        </button>
                        {/* Both write the same field shape and the type
                            dropdown swaps between them, so this is a shortcut
                            rather than a second concept. */}
                        <button
                            type="button"
                            onClick={() => addFileField('notebook')}
                            className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] px-2 py-1 rounded transition"
                        >
                            <Plus size={12} /> {t('automations.form_builder_fields.add_an_open_in_notebooks', 'Add an Open in Notebooks')}
                        </button>
                    </div>
                </div>
            )}

            <ThemeEditor
                theme={theme}
                inherits={inherits}
                canInherit={bindingBase !== 'trigger.output'}
                onChange={(next) => patch({ theme: next })}
            />

            {/* Only reached when onTestSubmit is null (a form_page step's
                inert look-see) — the trigger's own copy already rendered near
                the top, above. */}
            {!onTestSubmit && previewSection}
        </div>
    );
}

function FieldCard({ field, index, count, bindingBase, onChange, onRemove, onMove, allowVariables = false, onFocusField = null, previewSample = null, siblings = [], onRenameField = null }) {
    const { t } = useTranslation();
    const [showAdvanced, setShowAdvanced] = useState(false);
    // The choices textarea keeps its OWN text. The stored array is trimmed and
    // blank-free, so deriving the value from it would eat the trailing space or
    // newline the moment one is typed: the write-back is synchronous, the join
    // recomputes without that character, and React re-asserts node.value — the
    // keystroke is reverted on its own event and the caret jumps to the end of
    // the box. Same mechanism, same cure as App Studio's AiChatInspector.
    const joinedOptions = joinOptions(field.options);
    const [optionsText, setOptionsText] = useState(joinedOptions);
    // Our own echo round-trips to the same list, so this stays equal while
    // typing. Only an edit from OUTSIDE (an undo, the AI builder, a reordered
    // card reusing this index) disagrees, and that is what we adopt.
    if (splitOptions(optionsText).join('\n') !== splitOptions(joinedOptions).join('\n')) setOptionsText(joinedOptions);
    // Both point at a generated file by id, and neither collects anything —
    // only the button on the visitor's page differs.
    const isDownload = DISPLAY_FIELD_TYPES.includes(field.type);

    // Same rule as the page-level slots: a template only makes sense where the
    // server has a run to interpolate against. See `textSlot` above.
    const slot = (key, ariaLabel, placeholder = '') => (
        allowVariables ? (
            <TemplateField
                value={field[key] || ''}
                onChange={(next) => onChange({ [key]: next })}
                rows={1}
                multiline={false}
                inline
                ariaLabel={ariaLabel}
                onFocusField={onFocusField}
                previewSample={previewSample}
                placeholder={placeholder}
                listAs="markdown"
            />
        ) : (
            <input
                type="text"
                aria-label={ariaLabel}
                value={field[key] || ''}
                onChange={(e) => onChange({ [key]: e.target.value })}
                className={denseInputClass('w-full')}
                placeholder={placeholder}
            />
        )
    );

    return (
        <div className={cardClass()}>
            <div className="flex items-center gap-1">
                <span className="flex-1 text-xs font-medium text-[var(--text-primary)] truncate">{field.label || field.name}</span>
                <button type="button" onClick={() => onMove(-1)} disabled={index === 0} aria-label={t('automations.form_builder_fields.move_question_up', 'Move question up')} title={t('automations.form_builder_fields.move_up', 'Move up')}
                    className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30">
                    <ChevronUp size={12} />
                </button>
                <button type="button" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={t('automations.form_builder_fields.move_question_down', 'Move question down')} title={t('automations.form_builder_fields.move_down', 'Move down')}
                    className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30">
                    <ChevronDown size={12} />
                </button>
                <button type="button" onClick={onRemove} aria-label={`Remove ${field.label || field.name}`} title={t('automations.form_builder_fields.remove_this_question', 'Remove this question')}
                    className="p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-500/10">
                    <Trash2 size={12} />
                </button>
            </div>

            <div className="flex items-start gap-2">
                {/* NOTE: `name` is deliberately untouched by this field. It was
                    slugged once when the question was created; re-deriving it
                    here would break every downstream <base>.<name> binding
                    silently. */}
                <div className="flex-1 min-w-0">
                    {slot('label', t('automations.form_builder_fields.question_label', 'Question {n} label', { n: index + 1 }), t('automations.form_builder_fields.what_to_ask', 'What do you want to ask?'))}
                </div>
                <select
                    aria-label={t('automations.form_builder_fields.question_type', 'Question {n} type', { n: index + 1 })}
                    value={field.type || 'text'}
                    onChange={(e) => onChange({ type: e.target.value })}
                    className={denseInputClass('!w-auto shrink-0')}
                >
                    {FIELD_TYPES.map(ft => <option key={ft.value} value={ft.value}>{t(`automations.form_builder_fields.type_${ft.value}`, ft.label)}</option>)}
                </select>
            </div>

            {/* A download collects nothing, so "Required" would be a promise
                the form can never check. The server skips it for the same
                reason (DISPLAY_FIELD_TYPES). */}
            {!isDownload && (
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer select-none">
                    <input type="checkbox" checked={!!field.required} onChange={(e) => onChange({ required: e.target.checked })} />
                    {t('automations.form_builder_fields.required', 'Required')}
                </label>
            )}

            {isDownload && (
                <div className="space-y-0.5">
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('automations.form_builder_fields.file_to_offer', 'File to offer')}</div>
                    {slot('fileId', `Download ${index + 1} file`, '{{steps.<id>.output.fileId}}')}
                    <p className="text-[10px] text-[var(--text-tertiary)]">
                        {t('automations.form_builder_fields.point_this_at_the_make_a', 'Point this at the Make a document step, e.g.')}{' '}
                        <code>{'{{steps.doc_1.output.fileId}}'}</code>{t('automations.form_builder_fields.the_link_is_built_when_the', '. The link is built when the page is shown and only works for this visitor.')}
                    </p>
                </div>
            )}

            {field.type === 'select' && (
                <div className="space-y-0.5">
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('automations.form_builder_fields.choices_one_per_line', 'Choices (one per line)')}</div>
                    <textarea
                        rows={4}
                        aria-label={`Question ${index + 1} choices`}
                        value={optionsText}
                        onChange={(e) => {
                            setOptionsText(e.target.value);
                            onChange({ options: splitOptions(e.target.value) });
                        }}
                        className={textareaClass()}
                        placeholder={'Red\nGreen\nBlue'}
                    />
                </div>
            )}

            {field.type === 'app_pick' && <AppPickEditor field={field} index={index} onChange={onChange} />}

            {field.type === 'file' && (
                <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('automations.form_builder_fields.accepted_types', 'Accepted types')}</div>
                        <input type="text" value={field.accept || ''} onChange={(e) => onChange({ accept: e.target.value })} className={denseInputClass('w-full')} placeholder={t('automations.form_builder_fields.application_pdf_image', 'application/pdf,image/*')} />
                    </div>
                    <div className="w-24 shrink-0 space-y-0.5">
                        <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('automations.form_builder_fields.max_mb', 'Max MB')}</div>
                        <input type="number" min={1} max={25} value={field.maxSizeMb ?? 10} onChange={(e) => onChange({ maxSizeMb: Number(e.target.value) || 10 })} className={denseInputClass('w-full')} />
                    </div>
                </div>
            )}

            {/* Advanced holds a placeholder and a binding name — both meaningless
                for a field that is never filled in and never submitted. */}
            {!isDownload && (
                <button
                    type="button"
                    onClick={() => setShowAdvanced(v => !v)}
                    className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                    {showAdvanced ? 'Hide advanced' : 'Advanced'}
                </button>
            )}
            {!isDownload && showAdvanced && (
                <div className="space-y-1.5">
                    <div className="space-y-0.5">
                        <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('automations.form_builder_fields.placeholder', 'Placeholder')}</div>
                        {slot('placeholder', `Question ${index + 1} placeholder`)}
                    </div>
                    <BindingNameField
                        field={field}
                        siblings={siblings}
                        bindingBase={bindingBase}
                        onRenameField={onRenameField}
                        onChange={onChange}
                    />
                </div>
            )}
        </div>
    );
}

/**
 * "Pick from an app" — which app, how many, and whether the record's CONTENT
 * travels into the run or only a reference to it.
 *
 * What is deliberately NOT here: any way to choose a particular record. The
 * author asks the question; the person filling the form in answers it from
 * THEIR OWN account. That is why an app the author has not connected is still
 * offered (greyed hint, not a locked row) — a manager can perfectly well ask
 * their team for a Fireflies transcript without having Fireflies themselves.
 */
function AppPickEditor({ field, index, onChange }) {
    const { t } = useTranslation();
    const sources = usePickSources();
    const chosen = sources.find(s => s.id === field.source) || null;
    // A source that is set but unknown to this install — an imported automation,
    // or an app that has since been removed. Said out loud rather than quietly
    // reset, because resetting would change what the form asks for.
    const unknown = !!field.source && sources.length > 0 && !chosen;

    return (
        <div className="space-y-1.5">
            <div className="space-y-0.5">
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('automations.form_builder_fields.app_to_pick_from', 'App to pick from')}</div>
                <select
                    aria-label={`Question ${index + 1} app`}
                    value={field.source || ''}
                    onChange={(e) => onChange({ source: e.target.value })}
                    className={denseInputClass('w-full')}
                >
                    <option value="">{t('automations.form_builder_fields.choose_an_app', 'Choose an app…')}</option>
                    {sources.map(s => (
                        <option key={s.id} value={s.id}>
                            {s.label}{s.available ? '' : ' — not connected for you'}
                        </option>
                    ))}
                </select>
                {unknown && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-500">
                        “{field.source}{t('automations.form_builder_fields.is_not_an_app_this_workspace', '” is not an app this workspace can pick from. Choose another one, or connect it first.')}
                    </p>
                )}
                {chosen && (
                    <p className="text-[10px] text-[var(--text-tertiary)]">
                        {t('automations.form_builder_fields.whoever_fills_this_form_in_searches', 'Whoever fills this form in searches their OWN')} {chosen.app}
                        {chosen.available ? '' : ' — you have not connected it yourself, so you will not be able to try the search here'}.
                    </p>
                )}
            </div>

            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={!!field.multiple}
                    onChange={(e) => onChange({ multiple: e.target.checked, ...(e.target.checked ? {} : { maxItems: undefined }) })}
                />
                {t('automations.form_builder_fields.allow_more_than_one', 'Allow more than one')}
            </label>

            {field.multiple && (
                <div className="flex items-center gap-2">
                    <div className="w-24 shrink-0 space-y-0.5">
                        <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('automations.form_builder_fields.max', 'Max')}</div>
                        <input
                            type="number"
                            min={1}
                            max={10}
                            aria-label={`Question ${index + 1} maximum records`}
                            value={field.maxItems ?? 5}
                            onChange={(e) => onChange({ maxItems: Number(e.target.value) || 5 })}
                            className={denseInputClass('w-full')}
                        />
                    </div>
                </div>
            )}

            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={field.withText !== false}
                    onChange={(e) => onChange({ withText: e.target.checked })}
                />
                {t('automations.form_builder_fields.bring_the_content_into_the_automation', 'Bring the content into the automation')}
            </label>
            <p className="text-[10px] text-[var(--text-tertiary)]">
                {field.withText !== false
                    ? <>{t('automations.form_builder_fields.the_record_is_read_when_the', 'The record is read when the form is submitted, so a later step can use')} <code>{field.name}.text</code> {t('automations.form_builder_fields.the_transcript_the_email_body_the', '— the transcript, the email body, the note.')}</>
                    : <>{t('automations.form_builder_fields.only_a_reference_travels_the_title', 'Only a reference travels: the title and the id. Nothing is read from the app.')}</>}
            </p>
        </div>
    );
}

function ThemeEditor({ theme, onChange, inherits = false, canInherit = false }) {
    const { t } = useTranslation();
    const activePreset = THEME_PRESETS.find(p => Object.keys(p.theme).every(k => p.theme[k] === theme?.[k]));
    return (
        <div className="space-y-2">
            <div className={subLabelClass()}>{t('automations.form_builder_fields.styling', 'Styling')}</div>

            {canInherit && (
                // A later page defaults to the trigger's look so a form does not
                // change appearance halfway through. Overriding is one click,
                // and going back is the same click.
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={inherits}
                        onChange={(e) => onChange(e.target.checked ? null : { ...theme })}
                    />
                    {t('automations.form_builder_fields.match_the_first_page', 'Match the first page')}
                </label>
            )}

            {!(canInherit && inherits) && (
                <>
                    <div className="flex flex-wrap gap-1.5">
                        {THEME_PRESETS.map(p => (
                            <button
                                key={p.id}
                                type="button"
                                onClick={() => onChange({ ...p.theme })}
                                aria-pressed={activePreset?.id === p.id}
                                className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] border transition ${
                                    activePreset?.id === p.id
                                        ? 'border-[var(--accent)] text-[var(--text-primary)] bg-[var(--accent)]/10'
                                        : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                                }`}
                            >
                                <span className="h-3 w-3 rounded-full shrink-0" style={{ background: p.theme.primary }} />
                                {p.label}
                            </button>
                        ))}
                    </div>

                    <div className="space-y-0.5">
                        <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('automations.form_builder_fields.accent_colour', 'Accent colour')}</div>
                        <div className="flex flex-wrap items-center gap-1">
                            {COLOR_PRESETS.map(hex => (
                                <button
                                    key={hex}
                                    type="button"
                                    aria-label={`Accent ${hex}`}
                                    onClick={() => onChange({ ...theme, primary: hex })}
                                    className={`h-5 w-5 rounded-full transition hover:scale-110 ${theme?.primary === hex ? 'ring-2 ring-offset-1 ring-[var(--text-primary)]' : ''}`}
                                    style={{ background: hex }}
                                />
                            ))}
                            <input
                                type="color"
                                aria-label={t('automations.form_builder_fields.custom_accent_colour', 'Custom accent colour')}
                                value={theme?.primary || '#0F766E'}
                                onChange={(e) => onChange({ ...theme, primary: e.target.value })}
                                className="h-5 w-7 rounded cursor-pointer border-0 bg-transparent p-0"
                            />
                        </div>
                    </div>

                    {THEME_KNOBS.map(knob => (
                        <div key={knob.key} className="flex items-center gap-2">
                            <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{knob.label}</span>
                            <div className="flex gap-1 flex-wrap">
                                {knob.values.map(v => (
                                    <button
                                        key={v}
                                        type="button"
                                        onClick={() => onChange({ ...theme, [knob.key]: v })}
                                        aria-pressed={theme?.[knob.key] === v}
                                        className={`px-1.5 py-0.5 rounded text-[10px] border transition ${
                                            theme?.[knob.key] === v
                                                ? 'border-[var(--accent)] text-[var(--text-primary)] bg-[var(--accent)]/10'
                                                : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                                        }`}
                                    >
                                        {v}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </>
            )}
        </div>
    );
}
