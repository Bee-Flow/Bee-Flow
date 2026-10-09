import { replaceTemplate } from '@shared/expr/path.mjs';
import { templateText } from '@shared/expr/templateText.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { onBindingDragOver, getBindingDropPath } from './bindingDnd';
import { useFormRowLabel } from './FormRowLabelContext';
import InsertDataButton from './InsertDataButton';
import RefTokenInput from './RefTokenInput';
import TemplateFitMore from './TemplateFitMore';
import { hasToken, replaceLastToken, templateShapeAt } from './templateRemedies';
import useVariablePicker from './useVariablePicker';
import VariablePicker from './VariablePicker';
import { useVariablePickerContext } from './VariablePickerContext';
import { useTranslation } from '../../../../hooks/useTranslation';
import { walkPath, previewValue, getAutocompleteTokenFromPrefix, detectTemplate, formatPathForInsert } from '../../../../utils/bindingHelpers';
import { denseInputClass } from '../flow/settings/formStyles';

/**
 * Multi-line string field with `{{path}}` interpolation. Unlike
 * BindingField (which produces a `{kind, value/path}` binding object),
 * TemplateField produces a plain string — used for raw string slots
 * like the AI step's prompt and the Notification body/title where the
 * runtime resolver interpolates `{{path}}` directly via the
 * `template`-kind code path inside `resolveValue`.
 *
 * Variable tree clicks/drops insert `{{path}}` at the caret — as a PILL. The
 * editing surface is RefTokenInput, so a reference reads "gmail read ▸ Output"
 * while you type, not `{{steps.act_f9aaff0e.output.results[*].output}}`.
 *
 * Props:
 *   value           — current string
 *   onChange        — (next: string) => void
 *   label / hint    — optional descriptions
 *   placeholder     — input placeholder
 *   rows            — textarea row count (default 4)
 *   onFocusField    — registers an `insert` handle with the parent so
 *                     the VariableTree can splice into this field
 *   previewSample   — merged sample tree for resolving `{{path}}`
 *                     occurrences in the preview line below
 *   multiline       — false renders a one-line <input> instead of a
 *                     textarea, for slots that sit in a tight row
 *   inline          — put the {} button beside the field instead of in a
 *                     header row above it (same reason)
 *   ariaLabel       — accessible name for the control itself, for slots
 *                     whose visible label lives outside this component
 *   listAs          — how the RUNTIME renders a `{{path}}` that is a list,
 *                     so the example and the note under it tell the truth:
 *                     'text' (default) — a list of plain values as
 *                     "red, green, blue", a list of records as JSON text
 *                     with a note on how to get plain text instead; 'json' — JSON, which is what
 *                     the slot wants (an http_request body), so a neutral
 *                     line; 'markdown' — a bullet list for a list of plain
 *                     values (interpolateTemplate's listAsMarkdown: form
 *                     pages, approval details, slide content)
 */
export default function TemplateField({
    value = '',
    onChange,
    label = null,
    hint = null,
    placeholder = '',
    rows = 4,
    onFocusField,
    previewSample = null,
    multiline = true,
    inline = false,
    ariaLabel = null,
    listAs = 'text',
    // "A separate run for each item" under More: the step's forEach setter
    // (useForEachRequest). Absent: that choice is simply not offered.
    onRequestForEach = null,
    canForEach = null,
}) {
    const rowLabel = useFormRowLabel();
    const [text, setText] = useState(value || '');
    const inputRef = useRef(null);
    const picker = useVariablePicker();
    const pickerCtx = useVariablePickerContext();
    const effectivePreviewSample = previewSample ?? pickerCtx.previewSample;
    const pickerGroups = pickerCtx.groups;
    const stepLabelById = pickerCtx.stepLabelById;
    const stepTypeById = pickerCtx.stepTypeById;

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setText(value || '');
    }, [value]);

    const emit = (next) => {
        setText(next);
        onChange?.(next);
    };

    // The list, table or group just put in, for "More" (TemplateFitMore). A
    // data slot never gets it: there the value goes in as JSON on purpose.
    const [fitPath, setFitPath] = useState(null);
    const noteFit = (path) => {
        if (listAs === 'json') return;
        setFitPath(templateShapeAt(path, effectivePreviewSample) ? path : null);
    };
    const chooseFit = (r) => {
        const path = fitPath;
        setFitPath(null);
        if (!path) return;
        if (r.forEach) onRequestForEach?.(r.forEach);
        emit(replaceLastToken(text, path, r.token));
    };
    const fitVisible = !!fitPath && hasToken(text, fitPath);

    // Inline autocomplete: typing an unclosed `{{partial` opens the picker
    // pre-filtered to the partial; picking swallows those characters and drops a
    // pill in their place. The LENGTH is recorded here rather than a range —
    // focus moves to the picker's search box, so the caret can't be trusted at
    // pick time.
    const autocompleteLength = useRef(0);
    const onInput = () => {
        const token = getAutocompleteTokenFromPrefix(inputRef.current?.textBeforeCaret() || '', 'fixed');
        if (token) {
            autocompleteLength.current = token.length;
            if (!picker.open) picker.openPicker(inputRef.current?.element, { initialQuery: token.query });
        }
    };

    // Every insertion writes the canonical `{{path}}` (formatPathForInsert): a
    // key with `-`, a space or a `}` in it is bracket-quoted, so the run's
    // quote-aware scan reads exactly the path that was picked.
    const tokenFor = (path) => formatPathForInsert(path, 'fixed');
    const insertPath = (path) => { const tok = tokenFor(path); if (tok) inputRef.current?.insertSnippet(tok); noteFit(path); };
    // A clicked pill: the picker opens on that pill's STEP and the answer
    // replaces the pill (user request 2026-09-03).
    const pillTarget = useRef(null);
    const onPillClick = ({ el, path }) => {
        autocompleteLength.current = 0;
        pillTarget.current = el;
        picker.openPicker(el, { focusPath: path });
    };
    const closePicker = () => { pillTarget.current = null; picker.closePicker(); };

    const onFocus = () => {
        if (!onFocusField) return;
        onFocusField({
            id: label || placeholder || 'template',
            label: label || rowLabel || '',
            insert: insertPath,
        });
    };

    const onDragOver = onBindingDragOver;
    const onDrop = (e) => {
        const path = getBindingDropPath(e);
        // Land where the author DROPPED, not where the caret last was.
        if (path && tokenFor(path)) { inputRef.current?.insertSnippetAt(tokenFor(path), { x: e.clientX, y: e.clientY }); noteFit(path); }
    };

    const { t } = useTranslation();
    const preview = renderPreview(text, effectivePreviewSample, listAs);

    const insertFromPicker = (path) => {
        const swallow = autocompleteLength.current;
        autocompleteLength.current = 0;
        const pill = pillTarget.current;
        pillTarget.current = null;
        if (pill) inputRef.current?.replacePill(pill, tokenFor(path));
        else if (swallow) inputRef.current?.replacePartial(swallow, tokenFor(path));
        else insertPath(path);
        if (pill || swallow) noteFit(path);
        picker.closePicker();
    };

    const control = (
        <div className={inline || !label ? 'flex-1 min-w-0' : ''}>
            <RefTokenInput
                ref={inputRef}
                value={text}
                mode="fixed"
                multiline={multiline}
                rows={rows}
                onChange={emit}
                onInput={onInput}
                onFocus={onFocus}
                onDragOver={onDragOver}
                onDrop={onDrop}
                placeholder={placeholder}
                // Named after its row ("Body") when it has no label of its own:
                // a contenteditable without a name is a nameless box to a screen reader.
                ariaLabel={ariaLabel || label || rowLabel || undefined}
                stepLabelById={stepLabelById}
                stepTypeById={stepTypeById}
                onPillClick={onPillClick}
                spaced={listAs !== 'json'}
                className={denseInputClass('w-full')}
            />
        </div>
    );

    const insertButton = (
        <InsertDataButton
            onClick={(e) => { autocompleteLength.current = 0; picker.openPicker(e.currentTarget); }}
            open={picker.open}
            className={inline ? 'self-stretch' : 'py-0.5'}
        />
    );

    return (
        <div className="space-y-1">
            {inline ? (
                <div className="flex items-stretch gap-1">
                    {control}
                    {insertButton}
                </div>
            ) : !label ? (
                // The row above already names the field: the button goes beside
                // it instead of on a line of its own.
                <div className="flex items-start gap-1">
                    {control}
                    {insertButton}
                </div>
            ) : (
                <>
                    <div className="flex items-center justify-between gap-2">
                        {label
                            ? <div className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</div>
                            : <span />}
                        {insertButton}
                    </div>
                    {control}
                </>
            )}
            {hint && <div className="text-[10px] text-[var(--text-tertiary)]">{hint}</div>}
            <VariablePicker
                {...picker.pickerProps}
                groups={pickerGroups}
                previewSample={effectivePreviewSample}
                onPick={insertFromPicker}
                onClose={closePicker}
                title={label ? `Insert into ${label}` : 'Insert variable'}
            />

            {fitVisible && (
                <TemplateFitMore
                    path={fitPath}
                    sampleRoot={effectivePreviewSample}
                    allowForEach={(canForEach ?? !!onRequestForEach) && !!onRequestForEach}
                    onChoose={chooseFit}
                />
            )}

            {preview != null && (
                <div className="text-[10px] text-[var(--text-tertiary)] space-y-0.5">
                    <div className="uppercase tracking-wide">{t('automations.template_field.example', 'example')}</div>
                    <div className="font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] rounded px-2 py-1">
                        {preview.text}
                    </div>
                    {preview.list && (
                        <div>
                            {t('automations.builder.template_array_json', 'The list goes in as JSON: {preview}', { preview: preview.list.preview })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Preview-only honesty: a `{{path}}` that resolves to an ARRAY used to
 * preview as "[2 items]", while the runtime (server/automation/bind.js
 * interpolateTemplate) writes the array into the surrounding text (a list of plain values as
 * "red, green, blue", a list of records as JSON) — or, with `listAsMarkdown`,
 * turns a list of plain values into bullets. The
 * example shows exactly what the run produces, and `list` carries the first
 * list that went in as JSON (its clipped text and the Formula that joins it)
 * for the note.
 */
function renderPreview(text, sampleRoot, listAs = 'text') {
    if (!text) return null;
    if (!detectTemplate(text)) return null; // no interpolation, no preview
    if (!sampleRoot) return { text, list: null };
    let list = null;
    // The runtime's quote-aware placeholder scan and its walker
    // (shared/expr/path.mjs), so `{{ x["a}b"] }}` previews what it runs.
    const filled = replaceTemplate(String(text), (path, full) => {
        const v = walkPath(path, sampleRoot);
        if (v === undefined) return full;
        if (Array.isArray(v)) {
            const bullets = listAs === 'markdown' ? markdownList(v) : null;
            if (bullets !== null) return bullets;
            // Exactly what the runtime writes (shared templateText): in a text
            // slot a list reads "red, green, blue" and a table one row per
            // line, so there is nothing to warn about; a data slot ('json')
            // keeps JSON, and says so in a neutral line.
            const clipped = clip(templateText(v, { lists: listAs === 'json' ? 'json' : 'join' }));
            if (listAs === 'json' && !list) list = { preview: clipped };
            return clipped;
        }
        // A record reads "key: value" in text and JSON in a data slot, in the
        // author's key order; everything else is what previewValue showed.
        if (v === null) return ''; // the run writes nothing for nothing
        if (typeof v === 'object') return clip(templateText(v, { lists: listAs === 'json' ? 'json' : 'join' }));
        return previewValue(v, 30);
    });
    return { text: filled, list };
}

const clip = (s) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);

const MARKDOWN_PREVIEW_ITEMS = 5;

/**
 * The bullet list interpolateTemplate's `listAsMarkdown` makes of a list of
 * plain values or a table (same shape: a blank line first, one `- ` per value
 * or row), clipped for the example. Null for a mixed list.
 */
function markdownList(v) {
    if (!v.length) return '';
    const scalar = (x) => x == null || ['string', 'number', 'boolean'].includes(typeof x);
    const isRec = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
    // A list of plain values, or a table (one bullet per row) — as the runtime.
    if (!v.every(scalar) && !v.every(x => x == null || isRec(x))) return null;
    const rows = v.every(scalar) ? v : v.filter(x => x != null);
    const shown = rows.slice(0, MARKDOWN_PREVIEW_ITEMS)
        .map(x => `- ${x == null ? '' : previewValue(isRec(x) ? templateText(x) : String(x).trim(), isRec(x) ? 60 : 30)}`);
    if (v.length > MARKDOWN_PREVIEW_ITEMS) shown.push('- …');
    return `\n\n${shown.join('\n')}\n`;
}
