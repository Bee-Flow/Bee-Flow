import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { suggestKeyFromPath } from '../../../../../utils/bindingHelpers';
import { rowInputClass, cardClass, subLabelClass } from '../../flow/settings/formStyles';
import ValueSlot from '../../valueSlot/ValueSlot';
import type { FieldHandle } from '../../valueSlot/fieldHandle';
import BindingField from '../BindingField';
import { onBindingDragOver, getBindingDropPath } from '../bindingDnd';

const toKey = suggestKeyFromPath as (path: string) => string;
const dropPath = getBindingDropPath as (e: unknown) => string | null;
const rowInput = rowInputClass as (extra?: string, opts?: { invalid?: boolean }) => string;

/**
 * Names JavaScript must never see as assigned object keys: `__proto__`
 * assignment does not create an own property, so the field silently vanishes
 * from the step output. Mirrors the server's parse_json name guard.
 */
const RESERVED_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Does this look like a binding path rather than a field name? */
const looksLikePath = (s: string) => /[.\s[\]]/.test(s);

/**
 * Field-NAME input that commits on blur/Enter instead of per keystroke
 * (node-audit B12). A live-controlled input lost focus after each character,
 * took a dropped PATH as the name, and let `__proto__` vanish at run time.
 * Dropping or typing a path now does what the user meant: the name becomes
 * the path's last segment and, on an empty row, the VALUE binds to the path.
 */
function FieldNameInput({ fieldKey, siblingKeys = [], onCommit, onAdoptPath = null, placeholder = 'field name', autoFocus = false }: {
    fieldKey: string;
    siblingKeys?: string[];
    onCommit: (key: string) => void;
    onAdoptPath?: ((path: string, suggested: string) => void) | null;
    placeholder?: string;
    autoFocus?: boolean;
}) {
    const [text, setText] = useState(fieldKey);
    const [error, setError] = useState<string | null>(null);
    const ref = useRef<HTMLInputElement | null>(null);
    useEffect(() => { setText(fieldKey); setError(null); }, [fieldKey]);
    // A freshly added row lands with a generated name: select it so the first
    // keystroke replaces it instead of appending to it.
    useEffect(() => { if (autoFocus) ref.current?.select(); }, [autoFocus]);

    const commit = (raw?: string) => {
        let cleaned = String(raw ?? text ?? '').trim();
        if (cleaned === fieldKey) { setText(fieldKey); setError(null); return; }
        if (!cleaned) { setText(fieldKey); setError('Name required — reverted.'); return; }
        if (looksLikePath(cleaned)) {
            const suggested = toKey(cleaned);
            if (onAdoptPath && /^(trigger|steps|vars|secrets|loop)[.[]/.test(cleaned)) {
                onAdoptPath(cleaned, suggested);
                setError(null);
                return;
            }
            cleaned = suggested;
        }
        if (RESERVED_FIELD_NAMES.has(cleaned)) { setError(`“${cleaned}” is a reserved name.`); return; }
        if (siblingKeys.includes(cleaned)) { setError(`A field named “${cleaned}” already exists.`); return; }
        setError(null);
        if (cleaned !== fieldKey) onCommit(cleaned);
        setText(cleaned);
    };

    return (
        <div className="flex-1 min-w-0">
            <input
                ref={ref}
                type="text"
                value={text}
                onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
                onBlur={() => commit()}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                onDragOver={onBindingDragOver}
                onDrop={(e) => {
                    const path = dropPath(e);
                    if (path) commit(path);
                }}
                placeholder={placeholder}
                aria-invalid={!!error}
                className={rowInput('w-full font-mono', { invalid: !!error })}
            />
            {error && <div className="mt-0.5 text-[10px] text-red-500">{error}</div>}
        </div>
    );
}

export interface GenericRowProps {
    fieldKey: string;
    siblingKeys?: string[];
    value: unknown;
    onChange: (binding: unknown) => void;
    onRename: (key: string) => void;
    onAdoptPath?: ((path: string, suggested: string) => void) | null;
    onRemove: () => void;
    onFocusField?: ((handle: FieldHandle) => void) | null;
    previewSample?: object | null;
    autoMapped?: boolean;
    visual?: boolean;
    nameLabel?: string | null;
    valueLabel?: string | null;
    namePlaceholder?: string;
    valuePlaceholder?: string;
    allowRaw?: boolean;
    autoFocusName?: boolean;
}

/** One user-named row: a field name and its value. */
export default function GenericRow({
    fieldKey, siblingKeys = [], value, onChange, onRename, onAdoptPath = null, onRemove,
    onFocusField, previewSample, autoMapped = false,
    visual = false, nameLabel = null, valueLabel = null,
    namePlaceholder = 'field name', valuePlaceholder = 'value',
    allowRaw = true, autoFocusName = false,
}: GenericRowProps) {
    const slotLabel = (text: string) => (
        <div className={`${subLabelClass()} mb-0.5`}>{text}</div>
    );
    return (
        <div className={cardClass()}>
            <div>
                {nameLabel && slotLabel(nameLabel)}
                <div className="flex items-center gap-1">
                    <FieldNameInput
                        fieldKey={fieldKey}
                        siblingKeys={siblingKeys}
                        onCommit={onRename}
                        onAdoptPath={onAdoptPath}
                        placeholder={namePlaceholder}
                        autoFocus={autoFocusName}
                    />
                    {autoMapped && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] uppercase tracking-wide" title="Auto-mapped">auto</span>
                    )}
                    <button
                        type="button"
                        onClick={onRemove}
                        title="Remove field"
                        aria-label="Remove field"
                        className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-[var(--bg-secondary)]"
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
            </div>
            <div>
                {valueLabel && slotLabel(valueLabel)}
                {visual ? (
                    <ValueSlot
                        value={value}
                        onChange={onChange}
                        placeholder={valuePlaceholder}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        allowRaw={allowRaw}
                        label={fieldKey}
                        fieldId={fieldKey}
                        field={fieldKey}
                    />
                ) : (
                    <BindingField
                        value={value}
                        onChange={onChange}
                        placeholder={valuePlaceholder}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                    />
                )}
            </div>
        </div>
    );
}
