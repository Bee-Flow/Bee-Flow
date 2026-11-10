import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { inputCls } from '@/components/admin/product-website/fields';

/**
 * A free #rrggbb colour next to the chart's palette swatches: a native colour
 * picker plus the hex as text. The runtime honours any 6-digit hex literal on
 * a series, band or line (runtime/chartPalette.resolveSeriesColor), so this
 * only ever writes that shape; a half-typed value stays in the box and is not
 * committed.
 */

const HEX_DIGITS = '0123456789abcdefABCDEF';

/** `#rrggbb` exactly, checked character by character. */
export function isHexColour(value: unknown): value is string {
    if (typeof value !== 'string' || value.length !== 7 || value[0] !== '#') return false;
    for (let i = 1; i < 7; i++) if (!HEX_DIGITS.includes(value[i])) return false;
    return true;
}

interface HexColourFieldProps {
    value?: string;
    /** What the chart draws when no colour is set (shown in the picker). */
    fallback: string;
    onPick: (colour: string) => void;
    label: string;
}

export default function HexColourField({ value, fallback, onPick, label }: HexColourFieldProps) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<string | null>(null);
    const current = isHexColour(value) ? value : '';
    return (
        <div className="flex items-center gap-2">
            <input
                type="color"
                className="w-8 h-8 shrink-0 cursor-pointer rounded border border-[var(--border-default)] bg-transparent p-0"
                value={current || fallback}
                onChange={(e) => { setDraft(null); onPick(e.target.value); }}
                aria-label={t('studio_apps_more_options.colour_picker_aria', 'Pick a colour for {name}', { name: label })}
            />
            <input
                type="text"
                className={inputCls}
                value={draft ?? current}
                onChange={(e) => {
                    const text = e.target.value.trim();
                    setDraft(text);
                    if (isHexColour(text)) onPick(text);
                }}
                onBlur={() => setDraft(null)}
                placeholder={t('studio_apps_more_options.hex_placeholder', '#rrggbb')}
                spellCheck={false}
                aria-label={t('studio_apps_more_options.hex_aria', 'Hex colour for {name}', { name: label })}
            />
        </div>
    );
}
