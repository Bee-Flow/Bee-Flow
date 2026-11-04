import React, { type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';

/**
 * The small controls the form-style groups are built from. Every one writes
 * through `onPick`/`onChange` at once, so the preview follows every click.
 */

export const ROW_LABEL = 'w-24 shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]';
const CHIP = 'px-1.5 py-0.5 rounded text-[10px] border transition';
const CHIP_ON = 'border-[var(--accent)] text-[var(--text-primary)] bg-[var(--accent)]/10';
const CHIP_OFF = 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]';

const chipClass = (on: boolean): string => `${CHIP} ${on ? CHIP_ON : CHIP_OFF}`;

/** A swatch's colour as a CSS variable: the `style` prop carries the variable, a class paints it. */
export const swatchVars = (hex: string): CSSProperties => ({ '--bf-swatch': hex } as CSSProperties);

/** One collapsible group (Look, Layout, …): a header button and its body. */
export function StyleGroup({ id, title, open, onToggle, children }: {
    id: string;
    title: string;
    open: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}) {
    const bodyId = `form-style-${id}`;
    return (
        <div className="rounded-md border border-[var(--border-default)]" data-testid={`form-style-group-${id}`}>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                aria-controls={bodyId}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-md"
            >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {title}
            </button>
            {open ? <div id={bodyId} className="px-2 pb-2 pt-1 space-y-2">{children}</div> : null}
        </div>
    );
}

export interface Option { value: string; label: string }

/**
 * A row of choices. With `withDefault`, a leading "Default" chip stands for
 * "not set" (a style knob the author never touched), and picking it clears the key.
 */
export function OptionRow({ label, options, value, onPick, withDefault = false }: {
    label: string;
    options: Option[];
    value: unknown;
    onPick: (value: string | undefined) => void;
    withDefault?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2" role="group" aria-label={label}>
            <span className={ROW_LABEL} aria-hidden="true">{label}</span>
            <div className="flex gap-1 flex-wrap">
                {withDefault ? (
                    <button type="button" onClick={() => onPick(undefined)} aria-pressed={value === undefined || value === null} className={chipClass(value === undefined || value === null)}>
                        {t('forms.style.default', 'Default')}
                    </button>
                ) : null}
                {options.map(o => (
                    <button key={o.value} type="button" onClick={() => onPick(o.value)} aria-pressed={value === o.value} className={chipClass(value === o.value)}>
                        {o.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** An optional colour: a picker, its hex, and a reset back to "not set". */
export function ColorRow({ label, value, fallback, onChange }: {
    label: string;
    value: unknown;
    /** What the picker opens on while nothing is set. */
    fallback: string;
    onChange: (hex: string | undefined) => void;
}) {
    const { t } = useTranslation();
    const set = typeof value === 'string' && HEX.test(value) ? value : null;
    return (
        <div className="flex items-center gap-2">
            <span className={ROW_LABEL}>{label}</span>
            <input
                type="color"
                aria-label={label}
                value={(set || fallback).toLowerCase()}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
                className="h-5 w-7 rounded cursor-pointer border-0 bg-transparent p-0"
            />
            <span className="text-[10px] font-mono text-[var(--text-tertiary)]">{set || t('forms.style.default', 'Default')}</span>
            {set ? (
                <button
                    type="button"
                    onClick={() => onChange(undefined)}
                    aria-label={t('forms.style.reset_named', 'Reset {name}', { name: label })}
                    className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                    <RotateCcw size={11} />
                </button>
            ) : null}
        </div>
    );
}
