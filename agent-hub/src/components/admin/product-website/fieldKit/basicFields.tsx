import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { AppIcon, IconPicker } from './jsDeps';
import { useTranslation } from '../../../../hooks/useTranslation';

// Shared input class to match other admin panels.
export const inputClass =
    'w-full px-3 py-2 rounded-md text-sm border bg-[var(--bg-tertiary)] ' +
    'border-[var(--border-default)] text-[var(--text-primary)] ' +
    'focus:outline-none focus:border-[var(--accent-primary)] transition-colors';

export type Align = 'left' | 'center' | 'right';

export function FieldRow({ label, hint, children }: { label?: ReactNode; hint?: ReactNode; children?: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5 mb-3">
            {label ? (
                <label className="text-xs font-medium text-[var(--text-secondary)]">{label}</label>
            ) : null}
            {children}
            {hint ? <span className="text-xs text-[var(--text-muted)]">{hint}</span> : null}
        </div>
    );
}

interface AutoTextareaProps {
    value: string | null | undefined;
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
    ariaLabel?: string;
    onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * AutoTextarea — a single-line-looking textarea that grows to fit its
 * content. Replaces <input type="text"> for any field whose visible
 * output is real prose (heading / body / label / …): an <input> silently
 * strips newlines, a textarea preserves them. Starts at one row, never
 * shows a scrollbar or drag handle, and re-measures on every value change.
 */
function AutoTextarea({ value, onChange, placeholder, className, ariaLabel, onKeyDown }: AutoTextareaProps) {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const resize = () => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    };
    // useLayoutEffect (not useEffect) so the height is correct before the
    // browser paints — avoids a one-frame flash at the default rows={1}
    // height when a field mounts with multi-line content.
    useLayoutEffect(() => { resize(); }, [value]);
    return (
        <textarea
            ref={ref}
            rows={1}
            className={className}
            style={{ resize: 'none', overflow: 'hidden' }}
            value={value || ''}
            placeholder={placeholder}
            aria-label={ariaLabel}
            onChange={(e) => onChange(e.target.value)}
            onInput={resize}
            onKeyDown={onKeyDown}
        />
    );
}

/**
 * AlignControl — a compact 3-button icon group (left / center / right)
 * for a single text field's alignment. `value` is the *resolved* current
 * alignment (callers pass `data.{field}Align || data.align || 'left'`);
 * `onChange` fires only on an explicit click, so the key is written into
 * block data lazily — never seeded as a default.
 */
export function AlignControl({ value, onChange }: { value?: string; onChange: (align: Align) => void }) {
    const { t } = useTranslation();
    const current: Align = (value === 'center' || value === 'right') ? value : 'left';
    const OPTIONS: { v: Align; icon: string; title: string }[] = [
        { v: 'left',   icon: 'AlignLeft',   title: t('cms_site.site.fields.align_left', 'Align left') },
        { v: 'center', icon: 'AlignCenter', title: t('cms_site.site.fields.align_center', 'Align center') },
        { v: 'right',  icon: 'AlignRight',  title: t('cms_site.site.fields.align_right', 'Align right') },
    ];
    return (
        <div
            className="inline-flex w-fit rounded-md border border-[var(--border-default)] overflow-hidden"
            role="group"
            aria-label={t('cms_site.site.fields.align_group', 'Text alignment')}
        >
            {OPTIONS.map((o, i) => {
                const active = current === o.v;
                return (
                    <button
                        key={o.v}
                        type="button"
                        title={o.title}
                        aria-pressed={active}
                        onClick={() => onChange(o.v)}
                        className={`px-2 py-1 transition-colors ${i > 0 ? 'border-l border-[var(--border-default)]' : ''} ${
                            active
                                ? 'bg-[var(--accent-primary)] text-white'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                        }`}
                    >
                        <AppIcon name={o.icon} className="w-3.5 h-3.5" />
                    </button>
                );
            })}
        </div>
    );
}

interface TextFieldProps {
    value: string | null | undefined;
    onChange: (value: string) => void;
    placeholder?: string;
    label?: string;
    hint?: ReactNode;
    align?: string;
    onAlignChange?: (align: Align) => void;
}

/**
 * TextField — a labelled text field. Renders an auto-growing textarea so
 * line breaks survive. When `onAlignChange` is supplied it also shows an
 * AlignControl directly below the field for that field's own alignment
 * (`align` is the resolved current value).
 */
export function TextField({ value, onChange, placeholder, label, hint, align, onAlignChange }: TextFieldProps) {
    return (
        <FieldRow label={label} hint={hint}>
            <AutoTextarea
                value={value}
                onChange={onChange}
                placeholder={placeholder}
                className={inputClass}
                ariaLabel={label}
            />
            {typeof onAlignChange === 'function' ? (
                <AlignControl value={align} onChange={onAlignChange} />
            ) : null}
        </FieldRow>
    );
}

interface TextAreaProps {
    value: string | null | undefined;
    onChange: (value: string) => void;
    placeholder?: string;
    label?: ReactNode;
    hint?: ReactNode;
    rows?: number;
}

export function TextArea({ value, onChange, placeholder, label, hint, rows = 3 }: TextAreaProps) {
    return (
        <FieldRow label={label} hint={hint}>
            <textarea
                className={inputClass}
                value={value || ''}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                rows={rows}
            />
        </FieldRow>
    );
}

export function Toggle({ value, onChange, label }: { value: boolean | null | undefined; onChange: (value: boolean) => void; label?: ReactNode }) {
    return (
        <label className="flex items-center justify-between gap-3 mb-3 cursor-pointer">
            <span className="text-sm text-[var(--text-primary)]">{label}</span>
            <span
                onClick={() => onChange(!value)}
                className={`relative w-10 h-5 rounded-full transition-colors ${value ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-default)]'}`}
            >
                <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${value ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
                />
            </span>
        </label>
    );
}

/**
 * IconField — value is a Lucide PascalCase name string, onChange(name).
 * The preview tile doubles as a button opening the IconPicker modal
 * (curated grid + search + free-text fallback); the raw text input stays
 * for power users. API unchanged from the plain-input version.
 */
export function IconField({ value, onChange, label }: { value: string | null | undefined; onChange: (name: string) => void; label?: string }) {
    const { t } = useTranslation();
    const [pickerOpen, setPickerOpen] = useState(false);
    return (
        <FieldRow label={label} hint={t('cms_site.site.fields.icon_hint', 'Lucide icon name (PascalCase) — e.g. ShieldCheck, Mail, Brain')}>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    title={t('cms_site.site.fields.icon_browse', 'Browse icons…')}
                    aria-label={t('cms_site.site.fields.icon_browse_label', '{label} — browse icons', { label: label || t('cms_site.site.fields.icon_default', 'Icon') })}
                    className="w-9 h-9 shrink-0 rounded-md flex items-center justify-center bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--accent-primary)] hover:border-[var(--accent-primary)] transition-colors cursor-pointer"
                >
                    {value ? <AppIcon name={value} className="w-5 h-5" /> : <span className="text-xs text-[var(--text-muted)]">?</span>}
                </button>
                <input
                    type="text"
                    className={inputClass}
                    value={value || ''}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={t('cms_site.site.fields.icon_placeholder', 'ShieldCheck')}
                />
            </div>
            {pickerOpen ? (
                <IconPicker
                    value={value || ''}
                    onSelect={(name) => { onChange(name); setPickerOpen(false); }}
                    onClose={() => setPickerOpen(false)}
                />
            ) : null}
        </FieldRow>
    );
}
