import React, { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { FieldRow } from '../fields';
import { parseRgbaOverlay, composeRgba } from './colorUtils';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * ColorControl — the ONE color affordance for the CMS admin. Swatch button
 * (native color input) + hex text field, visually matching the old
 * ColorRow/ColorSwatch/ColorOverrideRow trio it replaces (primitives.jsx
 * re-exports those as thin wrappers over this).
 *
 * Props:
 *   label / hint     — wraps the control in a FieldRow (omit for bare inline)
 *   value            — '#RRGGBB' (or 'rgba(…)' when allowAlpha) or empty
 *   onChange         — receives '#RRGGBB' / 'rgba(…)' / null (= reset)
 *   inheritFrom      — enables inherit semantics: empty value shows an
 *                      "Inherited" placeholder + the inherited color in the
 *                      swatch; a set value gets a Reset button (→ onChange(null)).
 *                      Pass '' when the site design has no color for the slot.
 *   compact          — small swatch + narrow hex field (old ColorSwatch look)
 *   allowAlpha       — value is an rgba() string; adds an opacity slider
 *                      composing rgba via colorUtils
 *   title            — tooltip / aria naming for label-less (compact) usage
 *
 * Hex commit rule (pinned by primitives.test.jsx via the ColorSwatch
 * wrapper): partial input stays local so the user can keep typing; only a
 * complete #RRGGBB commits. '#' is prefixed and non-hex chars stripped.
 */
type ParsedOverlay = ReturnType<typeof parseRgbaOverlay>;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const HEX_FIELD_BASE =
    'rounded text-xs font-mono border border-[var(--border-default)] bg-[var(--bg-tertiary)] ' +
    'text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]';

// Local typing buffer — partial hex never commits (see doc block above).
function useHexBuffer(hexValue: string, commitHex: (hex: string) => void): [string, (raw: string) => void] {
    const [hexInput, setHexInput] = useState(hexValue);
    useEffect(() => { setHexInput(hexValue); }, [hexValue]);
    const handleHexChange = (raw: string) => {
        const cleaned = raw.replace(/[^0-9a-fA-F#]/g, '');
        const withHash = cleaned.startsWith('#') ? cleaned : (cleaned ? `#${cleaned}` : '');
        setHexInput(withHash);
        if (HEX_RE.test(withHash)) commitHex(withHash);
    };
    return [hexInput, handleHexChange];
}

function AlphaSlider({ opacity, name, onChange }: { opacity: number; name: string; onChange: (opacity: number) => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[10px] text-[var(--text-muted)] shrink-0 w-14">
                {Math.round(opacity * 100)}%
            </span>
            <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={Math.round(opacity * 100)}
                aria-label={t('cms_site.site.controls.color_opacity', '{name} opacity', { name })}
                onChange={(e) => onChange(parseInt(e.target.value, 10) / 100)}
                className="flex-1 accent-[var(--accent-primary)]"
            />
        </div>
    );
}

interface SwatchInputProps {
    swatchHex?: string;
    displayName: string;
    inherited?: boolean;
    overridden?: boolean;
    compact?: boolean;
    onCommit: (hex: string) => void;
}

function SwatchInput({ swatchHex, displayName, inherited, overridden, compact, onCommit }: SwatchInputProps) {
    const { t } = useTranslation();
    return (
        <input
            type="color"
            value={swatchHex}
            onChange={(e) => onCommit(e.target.value)}
            title={inherited ? t('cms_site.site.controls.color_inherited_title', '{name} — inherited, click to override', { name: displayName }) : displayName}
            className={`${compact ? 'h-7 w-7 p-0 shrink-0' : 'h-8 w-10'} rounded border cursor-pointer bg-[var(--bg-tertiary)]
                ${overridden ? 'border-[var(--accent-primary)]' : 'border-[var(--border-default)]'}`}
            style={compact ? { minWidth: '28px' } : undefined}
        />
    );
}

interface HexInputProps {
    hexInput: string;
    placeholder: string;
    displayName: string;
    compact?: boolean;
    onHexChange: (raw: string) => void;
}

function HexInput({ hexInput, placeholder, displayName, compact, onHexChange }: HexInputProps) {
    const { t } = useTranslation();
    return (
        <input
            type="text"
            value={hexInput}
            onChange={(e) => onHexChange(e.target.value)}
            placeholder={placeholder}
            maxLength={7}
            spellCheck={false}
            aria-label={t('cms_site.site.controls.color_hex', '{name} hex', { name: displayName })}
            className={`${compact ? 'w-20 px-1.5 py-1 uppercase' : 'flex-1 px-2 py-1.5'} ${HEX_FIELD_BASE}`}
        />
    );
}

export interface ColorControlProps {
    label?: string;
    hint?: ReactNode;
    /** '#RRGGBB', or an rgba() string with `allowAlpha`; empty or absent = unset. */
    value?: string | null;
    /** Receives null (reset) only with `inheritFrom`, or when `allowAlpha` composes an invalid hex. A method so a `(v: string) => void` setter stays assignable. */
    onChange(value: string | null): void;
    inheritFrom?: string;
    compact?: boolean;
    allowAlpha?: boolean;
    title?: string;
}

export default function ColorControl({
    label,
    hint,
    value,
    onChange,
    inheritFrom,
    compact = false,
    allowAlpha = false,
    title,
}: ColorControlProps) {
    const { t } = useTranslation();
    const inheritable = inheritFrom !== undefined;
    const isSet = typeof value === 'string' && value !== '';

    // Resolve the current hex (+ opacity when allowAlpha) from the value.
    const parsed = allowAlpha ? parseRgbaOverlay(value) : null;
    // parsed is non-null exactly when allowAlpha (the line above), and both are fixed for this render.
    const hexValue = allowAlpha ? (parsed as ParsedOverlay).hex : (isSet && HEX_RE.test(value) ? value : '');
    const opacity = allowAlpha ? (parsed as ParsedOverlay).opacity : 1;

    const commitHex = (hex: string) => onChange(allowAlpha ? composeRgba(hex, opacity) : hex);
    const [hexInput, handleHexChange] = useHexBuffer(hexValue, commitHex);

    const displayName = title || label || t('cms_site.site.controls.color_default_name', 'Color');
    const swatchHex = HEX_RE.test(hexValue)
        ? hexValue
        : (HEX_RE.test(inheritFrom || '') ? inheritFrom : '#000000');
    const inheritPlaceholder = inheritFrom ? t('cms_site.site.controls.color_inherit', 'inherit {color}', { color: inheritFrom }) : '#RRGGBB';

    const inherited  = inheritable && !isSet;
    const overridden = inheritable && isSet;

    const row = (
        <div className={compact ? 'inline-flex items-center gap-1.5' : 'flex items-center gap-2'}>
            <SwatchInput
                swatchHex={swatchHex}
                displayName={displayName}
                inherited={inherited}
                overridden={overridden}
                compact={compact}
                onCommit={commitHex}
            />
            <HexInput
                hexInput={hexInput}
                placeholder={inheritable ? inheritPlaceholder : '#RRGGBB'}
                displayName={displayName}
                compact={compact}
                onHexChange={handleHexChange}
            />
            {inherited && !compact ? (
                <span className="text-[10px] text-[var(--text-muted)] italic shrink-0">{t('cms_site.site.controls.color_inherited', 'Inherited')}</span>
            ) : null}
            {overridden ? (
                <button
                    type="button"
                    onClick={() => onChange(null)}
                    className="text-xs text-[var(--text-muted)] hover:text-red-400 px-1"
                    title={t('cms_site.site.controls.color_reset_title', 'Reset to inherited')}
                >
                    {t('cms_site.site.controls.color_reset', 'Reset')}
                </button>
            ) : null}
        </div>
    );

    const alphaRow = allowAlpha ? (
        <AlphaSlider
            opacity={opacity}
            name={displayName}
            onChange={(a: number) => onChange(composeRgba(HEX_RE.test(hexValue) ? hexValue : '#000000', a))}
        />
    ) : null;

    if (!label && !hint) {
        return alphaRow ? <div>{row}{alphaRow}</div> : row;
    }
    return (
        <FieldRow label={label} hint={hint}>
            {row}
            {alphaRow}
        </FieldRow>
    );
}
