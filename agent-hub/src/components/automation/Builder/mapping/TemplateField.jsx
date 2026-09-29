import InsertDataButton from './InsertDataButton';
import { onBindingDragOver, getBindingDropPath } from './bindingDnd';
import React, { useEffect, useRef, useState } from 'react';
import RefTokenInput from './RefTokenInput';
import useVariablePicker from './useVariablePicker';
import VariablePicker from './VariablePicker';
import { useVariablePickerContext } from './VariablePickerContext';
import { walkPath, previewValue, getAutocompleteTokenFromPrefix } from '../../../../utils/bindingHelpers';
import { useTranslation } from '../../../../hooks/useTranslation';
import { denseInputClass, AMBER_NOTE } from '../flow/settings/formStyles';

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
 *                     'text' (default) — JSON text, with a note on how to
 *                     get plain text instead; 'json' — JSON, which is what
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
}) {
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

    const insertPath = (path) => inputRef.current?.insertSnippet(`{{${path}}}`);
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
            label: label || placeholder || 'template',
            insert: insertPath,
        });
    };

    const onDragOver = onBindingDragOver;
    const onDrop = (e) => {
        const path = getBindingDropPath(e);
        // Land where the author DROPPED, not where the caret last was.
        if (path) inputRef.current?.insertSnippetAt(`{{${path}}}`, { x: e.clientX, y: e.clientY });
    };

    const { t } = useTranslation();
    const preview = renderPreview(text, effectivePreviewSample, listAs);

    const insertFromPicker = (path) => {
        const swallow = autocompleteLength.current;
        autocompleteLength.current = 0;
        const pill = pillTarget.current;
        pillTarget.current = null;
        if (pill) inputRef.current?.replacePill(pill, `{{${path}}}`);
        else if (swallow) inputRef.current?.replacePartial(swallow, `{{${path}}}`);
        else insertPath(path);
        picker.closePicker();
    };

    const control = (
        <div className={inline ? 'flex-1 min-w-0' : ''}>
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
                ariaLabel={ariaLabel}
                stepLabelById={stepLabelById}
                stepTypeById={stepTypeById}
                onPillClick={onPillClick}
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

            {preview != null && (
                <div className="text-[10px] text-[var(--text-tertiary)] space-y-0.5">
                    <div className="uppercase tracking-wide">example</div>
                    <div className="font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] rounded px-2 py-1">
                        {preview.text}
                    </div>
                    {preview.list && (listAs === 'json' ? (
                        <div>
                            {t('routines.builder.template_array_json', 'The list goes in as JSON: {preview}', { preview: preview.list.preview })}
                        </div>
                    ) : (
                        <div className={AMBER_NOTE}>
                            {t('routines.builder.template_array_text', 'This list goes in as JSON text: {preview}. For plain text, join it first: add an Edit data step with a Formula field set to {expr}.', {
                                preview: preview.list.preview,
                                expr: preview.list.joinExpr,
                            })}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Preview-only honesty: a `{{path}}` that resolves to an ARRAY used to
 * preview as "[2 items]", while the runtime (server/automation/bind.js
 * interpolateTemplate) JSON.stringifies the array into the surrounding text —
 * or, with `listAsMarkdown`, turns a list of plain values into bullets. The
 * example shows exactly what the run produces, and `list` carries the first
 * list that went in as JSON (its clipped text and the Formula that joins it)
 * for the note.
 */
function renderPreview(text, sampleRoot, listAs = 'text') {
    if (!text) return null;
    if (!/\{\{[^}]+\}\}/.test(text)) return null; // no interpolation, no preview
    if (!sampleRoot) return { text, list: null };
    let list = null;
    const filled = String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, expr) => {
        const path = expr.trim();
        const v = walkPath(path, sampleRoot);
        if (v === undefined) return full;
        if (Array.isArray(v)) {
            const bullets = listAs === 'markdown' ? markdownList(v) : null;
            if (bullets !== null) return bullets;
            let asText;
            try { asText = JSON.stringify(v); } catch { asText = String(v); }
            const clipped = asText.length > 60 ? `${asText.slice(0, 59)}…` : asText;
            if (!list) list = { preview: clipped, joinExpr: joinFormula(path, v) };
            return clipped;
        }
        return previewValue(v, 30);
    });
    return { text: filled, list };
}

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The Edit data Formula that turns this list into plain text. `join` writes
 * every element with String(), so a list of records would come out as
 * "[object Object], …": for records it joins one column instead, the first
 * one the example row has that a formula can name.
 */
function joinFormula(path, v) {
    const first = v.find(x => x != null);
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
        const column = Object.keys(first).find(k => PLAIN_KEY.test(k)) || '<column>';
        return `join(${path}[*].${column}, ", ")`;
    }
    return `join(${path}, ", ")`;
}

const MARKDOWN_PREVIEW_ITEMS = 5;

/**
 * The bullet list interpolateTemplate's `listAsMarkdown` makes of a list of
 * plain values (same shape: a blank line first, one `- ` per value), clipped
 * for the example. Null for a list of records, which keeps its JSON there too.
 */
function markdownList(v) {
    if (!v.length) return '';
    if (!v.every(x => x == null || ['string', 'number', 'boolean'].includes(typeof x))) return null;
    const shown = v.slice(0, MARKDOWN_PREVIEW_ITEMS).map(x => `- ${x == null ? '' : previewValue(String(x).trim(), 30)}`);
    if (v.length > MARKDOWN_PREVIEW_ITEMS) shown.push('- …');
    return `\n\n${shown.join('\n')}\n`;
}
