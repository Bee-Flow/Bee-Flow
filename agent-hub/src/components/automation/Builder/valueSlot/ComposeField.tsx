import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { X } from 'lucide-react';
import { describeSource, humanizeKey, sourceProblems } from '@shared/mapping/index.mjs';
import type { MappingSource, PickIntent, PickPart } from '@shared/mapping/index.mjs';
import { useTranslation } from '../../../../hooks/useTranslation';
import { getAutocompleteTokenFromPrefix } from '../../../../utils/bindingHelpers';
import InsertDataButtonJs from '../mapping/InsertDataButton';
import useVariablePicker from '../mapping/useVariablePicker';
import VariablePickerJs from '../mapping/VariablePicker';
import { useVariablePickerContext } from '../mapping/VariablePickerContext';
import { denseInputClass } from '../flow/settings/formStyles';
import PickOptions from './PickOptions';
import ComposeExample from './ComposeExample';
import { pillSpecFor } from './composePills';
import { useRegisterSlot, useSlotRegistryContext } from './useSlotRegistry';
import { parseDraggedSource, SOURCE_MIME } from './slotDnd';
import {
    classifyPlaceholder, composeSite, exampleOf, isMappingValue, liftPlaceholder, normalizePieces, partForInsert,
    piecesFromValue, placeholderForInsert, placeholderPath, readablePlaceholder, valueFromPieces, withIntent, withNamedInputs,
} from './composeValue';
import type { InsertRequest, SlotPiece, TextValue } from './composeValue';
import {
    appendText, deleteBeforeCaret, ensureTrailingFiller, insertAtCaret, pillBeforeCaret,
    pieceOfPill, PILL_SELECTOR, rangeFromPoint, renderInto, replacePill, serializeHost, buildPill, textBeforeCaret,
} from './slotDom';
import type { PillSpec } from './slotDom';

/**
 * A text with values in it: a prompt, a message body, a subject, a file
 * name. "Beste [Naam van klant], uw orders: [Product van alle orderregels ≡ 12]".
 *
 * Each value is an inline PILL with its name in words: never a path, never
 * `{{ }}`, never "[object Object]". A value goes in at the caret (a click
 * in the source panel, a drop, the {} button, or `{{` typed to search) and
 * never wipes a character the author typed; Backspace after a pill removes
 * the whole pill. A list pill shows how many values it holds ("≡ 12"), and a
 * click on a value pill opens PickOptions: all of them one per line, with
 * commas, as a bulleted list, only the first, the number of them.
 *
 * What is stored follows the shared sites table (composeValue.ts): a text
 * whose step renders a compose is written as one, so a list in it reaches
 * the run as readable text instead of JSON. A legacy `{{ }}` template is
 * shown as pills (a placeholder that reads no value of an earlier step as a
 * grey Formula pill) and stays the string it is until the author changes
 * the field; only then is it lifted, by the same rule as the AI builder. A
 * text whose step takes plain text only stays a `{{ }}` template, with the
 * same pills. The example under the field shows what the run makes of it.
 * A formula typed next to a value no `{{ }}` can read the same way (all of a
 * list) is not saved: the field says so and keeps its last saved value until
 * one of the two is removed.
 *
 * It owns its DOM (slotDom.ts): a React re-render on every keystroke would
 * destroy the caret. The host is written from `value` on mount and when the
 * value changes to something it did not just emit (an undo, an AI patch).
 *
 * Props:
 *   value / onChange   string | compose | pick (a fill_document value)
 *   stepType / field   where the text sits (sites.mjs), e.g. 'notification' / 'body'
 *   slotKey            which of several fields at one site this is (a row
 *                      index, a form slot), so each registers on its own
 *   label / hint / placeholder / rows / multiline / inline / ariaLabel
 *   listAs             how the run renders a list in a `{{ }}` TEMPLATE, for
 *                      the example: 'text' (JSON), 'json' (JSON, which the
 *                      field wants), 'markdown' (bullets: form pages,
 *                      approval details, slide content)
 *   onFocusField       registers `{ id, label, insert(path, opts) }` with the
 *                      step drawer, so the source panel inserts here
 *   previewSample      the sample (or last run) the example and counts read
 *   namedInputs        the step's own inputs, which the run puts next to the
 *                      roots by name (an ai_step's prompt reads `{{toon}}`):
 *                      the example fills them in too
 */

const InsertDataButton = InsertDataButtonJs as unknown as React.ComponentType<{ onClick: (e: MouseEvent<HTMLButtonElement>) => void; open?: boolean; className?: string }>;
const VariablePicker = VariablePickerJs as unknown as React.ComponentType<Record<string, unknown>>;

// The legacy drag type a path travels under (mapping/bindingDnd.js). Read
// by its own type only: text/plain is a person moving words, never a path.
const BINDING_MIME = 'application/x-binding-path';

/** The handle the step drawer keeps for the focused field. */
export interface FocusHandle {
    id: string;
    label: string;
    insert: (path: string, opts?: { raw?: boolean; source?: MappingSource | null }) => void;
}

export interface ComposeFieldProps {
    value?: unknown;
    onChange?: (next: TextValue) => void;
    stepType?: string;
    field?: string;
    /** Which of several fields with the same stepType/field this one is: part of its registry id. */
    slotKey?: string | null;
    label?: string | null;
    hint?: ReactNode;
    placeholder?: string;
    rows?: number;
    multiline?: boolean;
    inline?: boolean;
    ariaLabel?: string | null;
    listAs?: 'text' | 'json' | 'markdown';
    onFocusField?: ((handle: FocusHandle) => void) | null;
    previewSample?: object | null;
    namedInputs?: Record<string, unknown> | null;
    required?: boolean;
    disabled?: boolean;
}

type PillTarget = { el: Element; index: number };
type OptionsFor = { index: number; el: Element; part: PickPart; name: string };

const keyOf = (v: unknown): string => (typeof v === 'string' ? `s:${v}` : `j:${JSON.stringify(v ?? '')}`);
const nonText = (pieces: SlotPiece[]) => pieces.filter(p => typeof p !== 'string').length;

/**
 * Where a pill sits among the pills the field holds once its typed or pasted
 * `{{ }}` text is read as pills too (the blur rebuild): the index replacePill
 * finds it by when that rebuild has replaced the element. Its index among
 * the pill elements would point at an earlier, pasted value instead.
 */
function pieceIndexOf(host: Element, pill: Element): number {
    const range = document.createRange();
    range.setStart(host, 0);
    range.setEndBefore(pill);
    const before = document.createElement('div');
    before.appendChild(range.cloneContents());
    return nonText(normalizePieces(serializeHost(before)));
}

/** What a drop carries that this field takes: a Source, a legacy path, or both. Plain text is not ours. */
export function droppedValue(e: { dataTransfer: DataTransfer | null; preventDefault: () => void }): InsertRequest | null {
    const dt = e.dataTransfer;
    if (!dt) return null;
    let req: InsertRequest | null = null;
    const rawSource = dt.getData(SOURCE_MIME);
    if (rawSource) {
        const dragged = parseDraggedSource(rawSource);
        if (dragged) req = { source: dragged.source, shape: dragged.shape ?? null, ...(dragged.take ? { take: dragged.take } : {}) };
        else {
            // The source panel's rows send the bare Source.
            try {
                const source = JSON.parse(rawSource);
                if (!sourceProblems(source).length) req = { source };
            } catch { /* not a Source */ }
        }
    }
    const path = dt.getData(BINDING_MIME);
    if (path) req = { ...(req || {}), path };
    if (req) e.preventDefault();
    return req;
}

/** Is something this field takes being dragged? (Readable during dragover.) */
function isOurDrag(e: { dataTransfer: DataTransfer | null }): boolean {
    const types = e.dataTransfer?.types ? Array.from(e.dataTransfer.types) : [];
    return types.includes(SOURCE_MIME) || types.includes(BINDING_MIME);
}

export default function ComposeField({
    value = '',
    onChange,
    stepType,
    field,
    slotKey = null,
    label = null,
    hint = null,
    placeholder = '',
    rows = 4,
    multiline = true,
    inline = false,
    ariaLabel = null,
    listAs = 'text',
    onFocusField = null,
    previewSample = null,
    namedInputs = null,
    required = false,
    disabled = false,
}: ComposeFieldProps) {
    const { t } = useTranslation();
    const pickerCtx = useVariablePickerContext() as {
        groups: unknown[]; previewSample: object | null;
        stepLabelById: ReadonlyMap<string, string>; stepTypeById: ReadonlyMap<string, string>;
    };
    const sample = previewSample ?? pickerCtx.previewSample;
    const { stepLabelById, stepTypeById } = pickerCtx;
    const picker = useVariablePicker();
    const site = useMemo(() => composeSite(stepType, field), [stepType, field]);

    const hostRef = useRef<HTMLDivElement | null>(null);
    // The key of the value last handed to onChange: the parent echoes it back
    // as `value`, and re-rendering on that echo would drop the caret.
    const lastEmitted = useRef<string | null>(null);
    // Where the caret was when it was last inside the field. A click in the
    // source panel or on the {} button moves focus away; this is where
    // "insert here" means here.
    const caret = useRef<Range | null>(null);
    // The field held a compose (or pick) when it was loaded: it stays one
    // where the run takes one, even where a template is never lifted.
    const wasMapping = useRef(isMappingValue(value));
    const autocompleteLength = useRef(0);
    const pillTarget = useRef<PillTarget | null>(null);
    const [options, setOptions] = useState<OptionsFor | null>(null);
    const [empty, setEmpty] = useState(() => !piecesFromValue(value).length);
    // The formula that keeps the current text from being stored (valueFromPieces
    // returned null), or null when what is shown is what is saved.
    const [unsaved, setUnsaved] = useState<string | null>(null);

    const ctx = useMemo(() => ({ stepType, field, site }), [stepType, field, site]);
    const composeMode = site.compose && (site.lift || wasMapping.current);

    /** What a pill says, in the current language. */
    const pillFor = useCallback(
        (piece: Exclude<SlotPiece, string>): PillSpec => pillSpecFor(t, piece, { stepLabelById, stepTypeById, sample }),
        [t, stepLabelById, stepTypeById, sample],
    );

    const nodesFor = useCallback((pieces: SlotPiece[]): Node[] => {
        const frag = document.createDocumentFragment();
        for (const piece of pieces) {
            if (typeof piece === 'string') appendText(frag, piece);
            else frag.appendChild(buildPill(pillFor(piece)));
        }
        return Array.from(frag.childNodes);
    }, [pillFor]);

    const emit = useCallback(() => {
        const host = hostRef.current;
        if (!host) return;
        const pieces = serializeHost(host);
        const norm = normalizePieces(pieces);
        setEmpty(!norm.length);
        const next = valueFromPieces(pieces, { ...ctx, wasMapping: wasMapping.current });
        if (next === null) {
            // A formula next to a value no `{{ }}` reads the same way (all of
            // a list): storing either would change what the run reads. Keep
            // the saved value, and say which formula is in the way.
            const formula = norm.find((p): p is { raw: string } => typeof p !== 'string' && 'raw' in p && !liftPlaceholder(p.raw, ctx.stepType, ctx.field));
            setUnsaved(formula ? formula.raw : '{{ }}');
            return;
        }
        setUnsaved(null);
        lastEmitted.current = keyOf(next);
        onChange?.(next);
    }, [ctx, onChange]);

    // Write the value in: on mount, and whenever it changes from outside.
    const valueKey = keyOf(value);
    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        if (lastEmitted.current !== null && lastEmitted.current === valueKey) return;
        lastEmitted.current = null;
        wasMapping.current = isMappingValue(value);
        const pieces = piecesFromValue(value);
        renderInto(host, pieces, pillFor);
        setEmpty(!pieces.length);
        setUnsaved(null);
        setOptions(null);
        // Only the key decides; `value` itself is a new object on every render.
    }, [valueKey]);

    // A step's label changed, a step was deleted, the sample or the language
    // changed: the pills say so without touching the value. Not while the
    // field has focus: a rebuild would move the caret mid-sentence.
    useEffect(() => {
        const host = hostRef.current;
        if (!host || host.contains(document.activeElement)) return;
        renderInto(host, normalizePieces(serializeHost(host)), pillFor);
    }, [pillFor]);

    const saveCaret = useCallback(() => {
        const host = hostRef.current;
        const sel = window.getSelection?.();
        if (!host || !sel || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        if (host.contains(range.commonAncestorContainer)) caret.current = range.cloneRange();
    }, []);

    /** Does the text hold a placeholder that does not lift? Then it stays a template, and so does what goes in. */
    const holdsUnliftable = useCallback((): boolean => {
        const host = hostRef.current;
        if (!host) return false;
        return normalizePieces(serializeHost(host)).some(p => typeof p !== 'string' && 'raw' in p && !liftPlaceholder(p.raw, stepType, field));
    }, [stepType, field]);

    /** The pill a picked value becomes here: a compose part, or a `{{ }}` placeholder. */
    const pieceFor = useCallback((req: InsertRequest): Exclude<SlotPiece, string> | null => {
        if (composeMode && !holdsUnliftable()) {
            const part = partForInsert(req, site.slot, sample);
            if (part) return { part };
        }
        const raw = placeholderForInsert(req);
        return raw ? { raw } : null;
    }, [composeMode, holdsUnliftable, site.slot, sample]);

    type Where = { range?: Range | null; swallow?: number; target?: PillTarget | null };
    const insertValue = useCallback((req: InsertRequest, where: Where = {}) => {
        const host = hostRef.current;
        if (!host || disabled) return;
        const piece = pieceFor(req);
        if (!piece) return;
        const nodes = nodesFor([piece]);
        host.focus();
        if (where.target) {
            replacePill(host, where.target.el, nodes, { index: where.target.index });
        } else if (where.swallow) {
            deleteBeforeCaret(host, where.swallow, { range: caret.current });
            insertAtCaret(host, nodes);
        } else {
            insertAtCaret(host, nodes, { range: where.range !== undefined ? where.range : caret.current });
        }
        caret.current = null;
        emit();
    }, [disabled, pieceFor, nodesFor, emit]);

    // The source panel's click lands here through the step drawer's handle.
    const insertPath = useCallback((path: string, opts?: { source?: MappingSource | null; take?: 'each' }) => {
        insertValue({ path, source: opts?.source ?? null, ...(opts?.take ? { take: opts.take } : {}) });
    }, [insertValue]);

    // Unique within the step: the form's text slots, a presentation's slide
    // rows and an approval's attachments share one site each.
    const id = `${stepType || 'text'}.${field || label || placeholder || 'text'}${slotKey ? `.${slotKey}` : ''}`;
    // What the field is called where the panel says where a value goes: its
    // label, else its own name ("Body"); never its example text, which is a
    // template with paths in it.
    const name = label || ariaLabel || humanizeKey(String(field || '').split('.').pop() || '') || '';
    const shownPlaceholder = placeholder ? readablePlaceholder(placeholder) : '';
    const registry = useSlotRegistryContext();
    const { onFocus: onRegistryFocus } = useRegisterSlot(registry, {
        id,
        label: name,
        required,
        isEmpty: () => empty,
        accept: (dragged) => insertValue({ source: dragged.source, shape: dragged.shape ?? null, ...(dragged.take ? { take: dragged.take } : {}) }),
    });

    const onFocus = () => {
        onRegistryFocus();
        onFocusField?.({ id, label: name, insert: insertPath });
    };

    // Typing `{{su` opens the picker filtered to "su"; the pick swallows those
    // characters and puts a pill in their place.
    const onInput = () => {
        saveCaret();
        emit();
        const token = getAutocompleteTokenFromPrefix(textBeforeCaret(hostRef.current), 'fixed') as { length: number; query: string } | null;
        if (token) {
            autocompleteLength.current = token.length;
            if (!picker.open) picker.openPicker(hostRef.current, { initialQuery: token.query });
        }
    };

    const openPickerFor = (anchor: Element | null, focusPath = '') => {
        autocompleteLength.current = 0;
        picker.openPicker(anchor, { focusPath });
    };

    const insertFromPicker = (path: string) => {
        const swallow = autocompleteLength.current;
        autocompleteLength.current = 0;
        const target = pillTarget.current;
        pillTarget.current = null;
        insertValue({ path }, target ? { target } : swallow ? { swallow } : {});
        picker.closePicker();
    };
    const closePicker = () => { pillTarget.current = null; picker.closePicker(); };

    /** The part a pill stands for, when PickOptions can change how it is used. */
    const optionsPart = (piece: Exclude<SlotPiece, string> | null): PickPart | null => {
        if (!piece) return null;
        if ('part' in piece) return piece.part;
        if (!composeMode || holdsUnliftable()) return null;
        return liftPlaceholder(piece.raw, stepType, field);
    };

    const onClick = (e: MouseEvent<HTMLDivElement>) => {
        const host = hostRef.current;
        const pill = (e.target as Element | null)?.closest?.(PILL_SELECTOR);
        if (!host || !pill || !host.contains(pill) || disabled) return;
        e.preventDefault();
        const index = pieceIndexOf(host, pill);
        // The clicked pill's own piece. Typed or pasted `{{ }}` text is not a
        // pill until the field blurs, so the pieces of the whole text do not
        // line up with the pill elements.
        const piece = pieceOfPill(pill);
        const part = optionsPart(piece);
        if (part && !sourceProblems(part.from).length) {
            setOptions({ index, el: pill, part, name: pillFor({ part }).name });
            return;
        }
        // A `{{ }}` value in a text that stays a template: pick another value
        // in its place, the picker opened on that value's step.
        if (piece && 'raw' in piece && classifyPlaceholder(piece.raw).kind === 'value') {
            pillTarget.current = { el: pill, index };
            openPickerFor(pill, placeholderPath(piece.raw));
        }
    };

    const applyIntent = (intent: PickIntent) => {
        const host = hostRef.current;
        if (!host || !options) return;
        replacePill(host, options.el, nodesFor([{ part: withIntent(options.part, intent) }]), { index: options.index });
        emit();
        setOptions(null);
    };

    const repick = () => {
        if (!options) return;
        pillTarget.current = { el: options.el, index: options.index };
        const path = describeSource(options.part.from);
        setOptions(null);
        picker.openPicker(hostRef.current, { focusPath: path });
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const host = hostRef.current;
        if (!host) return;
        if (e.key === 'Escape' && options) { setOptions(null); return; }
        if (e.key === 'Enter') {
            e.preventDefault();
            // A one-line text must not gain a line.
            if (!multiline) return;
            insertAtCaret(host, [document.createElement('br')]);
            ensureTrailingFiller(host);
            emit();
            return;
        }
        if (e.key === 'Backspace') {
            // One press removes the whole pill, in every browser.
            const pill = pillBeforeCaret(host);
            if (!pill) return;
            e.preventDefault();
            pill.remove();
            setOptions(null);
            emit();
        }
    };

    // Paste as PLAIN TEXT: a copied fragment's styling and wrappers would not
    // survive serialization, and parts of what was pasted would silently go.
    const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
        e.preventDefault();
        const text = e.clipboardData?.getData('text/plain') ?? '';
        const host = hostRef.current;
        if (!text || !host) return;
        const frag = document.createDocumentFragment();
        appendText(frag, text);
        insertAtCaret(host, Array.from(frag.childNodes), { replace: true });
        emit();
    };

    // A `{{ … }}` typed by hand becomes a pill once the caret has left: never
    // while it is inside (rewriting mid-word would move the caret), and only
    // when there is one to make (a rebuild replaces every pill element, and a
    // pill that was just clicked must still be there to answer).
    const onBlur = () => {
        const host = hostRef.current;
        if (!host) return;
        const pieces = normalizePieces(serializeHost(host));
        if (nonText(pieces) !== host.querySelectorAll(PILL_SELECTOR).length) renderInto(host, pieces, pillFor);
    };

    const onDragOver = (e: DragEvent<HTMLDivElement>) => {
        if (!isOurDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent<HTMLDivElement>) => {
        const req = droppedValue(e);
        if (!req) return;
        // Land where the author DROPPED, not where the caret last was.
        const range = rangeFromPoint(hostRef.current, e.clientX, e.clientY);
        insertValue(req, { range: range || caret.current });
    };

    const example = useMemo(
        () => exampleOf(value, withNamedInputs(sample, namedInputs), listAs),
        [value, sample, namedInputs, listAs],
    );
    const liftsOnEdit = typeof value === 'string' && composeMode && (() => {
        const pieces = piecesFromValue(value);
        return pieces.every(p => typeof p === 'string' || 'part' in p || !!liftPlaceholder(p.raw, stepType, field));
    })();

    // Without a label of its own (the form names the field above it) the
    // button sits beside the field, as the value slot's ⋯ does, instead of
    // on a row of its own.
    const beside = inline || !label;
    const control = (
        <div className={`relative ${beside ? 'flex-1 min-w-0' : ''}`}>
            <div
                ref={hostRef}
                role="textbox"
                tabIndex={disabled ? -1 : 0}
                contentEditable={!disabled}
                suppressContentEditableWarning
                aria-multiline={multiline || undefined}
                aria-label={ariaLabel || label || undefined}
                aria-readonly={disabled || undefined}
                aria-placeholder={shownPlaceholder || undefined}
                // Mirrored for the test helpers and assistive tech that find
                // an editor by its placeholder; the visible one is painted below.
                {...{ placeholder: placeholder || undefined }}
                data-ref-editor=""
                data-compose-editor=""
                onInput={onInput}
                onKeyDown={onKeyDown}
                onKeyUp={saveCaret}
                onMouseUp={saveCaret}
                onClick={onClick}
                onPaste={onPaste}
                onFocus={onFocus}
                onBlur={onBlur}
                onDragOver={onDragOver}
                onDrop={onDrop}
                style={multiline ? { minHeight: `${Math.max(1, rows) * 1.5}rem` } : undefined}
                className={`${denseInputClass('w-full')} ${multiline ? 'whitespace-pre-wrap break-words' : 'whitespace-nowrap overflow-x-auto'} ${disabled ? 'opacity-60' : ''}`}
            />
            {empty && placeholder ? (
                <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute left-2 top-1.5 text-xs text-[var(--text-tertiary)] max-w-[calc(100%-1rem)] ${multiline ? 'whitespace-pre-line overflow-hidden' : 'truncate'}`}
                >
                    {shownPlaceholder}
                </span>
            ) : null}
        </div>
    );

    const insertButton = disabled ? null : (
        <InsertDataButton
            onClick={(e) => openPickerFor(e.currentTarget)}
            open={picker.open}
            className={inline ? 'self-stretch' : beside ? 'self-start py-1.5' : 'py-0.5'}
        />
    );

    return (
        <div className="space-y-1">
            {beside ? (
                <div className={`flex gap-1 ${inline ? 'items-stretch' : 'items-start'}`}>
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
            {unsaved !== null && (
                <div role="alert" data-testid="compose-unsaved" className="text-[10px] text-[var(--warning-ink)]">
                    {t('mapping.compose.unsaved_formula', 'The formula {formula} cannot be combined with the other values in this text. Remove one of them: until then, this change is not saved.', { formula: unsaved })}
                </div>
            )}
            {options && (
                <div className="relative" data-testid="compose-options">
                    <PickOptions
                        source={options.part.from}
                        sample={sample}
                        slot={site.slot}
                        value={options.part}
                        label={options.name}
                        onSelect={applyIntent}
                    />
                    <div className="absolute right-2 top-2 flex items-center gap-1">
                        <button
                            type="button"
                            onClick={repick}
                            className="rounded px-1 py-0.5 text-[11px] text-[var(--text-tertiary)] underline underline-offset-2 hover:text-[var(--text-primary)]"
                        >
                            {t('mapping.compose.repick', 'Pick another value')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setOptions(null)}
                            aria-label={t('mapping.compose.close_options', 'Close')}
                            className="rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        >
                            <X size={12} aria-hidden="true" />
                        </button>
                    </div>
                </div>
            )}
            <VariablePicker
                {...picker.pickerProps}
                groups={pickerCtx.groups}
                previewSample={sample}
                onPick={insertFromPicker}
                onClose={closePicker}
                title={label
                    ? t('mapping.compose.insert_into', 'Insert into {label}', { label })
                    : t('mapping.compose.insert', 'Insert a value')}
            />
            {example && <ComposeExample example={example} listAs={listAs} liftsOnEdit={liftsOnEdit} />}
        </div>
    );
}

