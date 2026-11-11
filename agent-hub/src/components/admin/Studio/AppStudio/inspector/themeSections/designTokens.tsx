import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { SectionTitle } from '../AiBrowsingSettings';
import { NumberField, TextField } from '../panels/kit';
import HexColourField, { isHexColour } from '../panels/HexColourField';
import { isTokenName } from '../../runtime/designTokens';
import { updateDesign } from '../../state/definitionOps';
import type { ThemeSectionEntry, ThemeSectionProps } from '../themeSections';

/**
 * The schema-3 design keys of package LK16: design.tokens (named colours and spacings, used as
 * `token:<name>` in colour knobs), design.radiusPx and design.dark (the colours on a dark ground).
 * Each change makes the look the author's own (preset "custom"), as the panel's design fields do;
 * an emptied key is removed (null), so an app that never used them keeps none.
 */

type Design = Record<string, unknown>;
const DARK_KEYS = ['primary', 'accent', 'canvas'] as const;

/** A token value as typed: a hex colour, or a whole number of pixels 0..96; null for anything else. */
export function parseTokenValue(text: string): string | number | null {
    const v = text.trim();
    if (isHexColour(v)) return v;
    const n = Number(v);
    return v !== '' && Number.isInteger(n) && n >= 0 && n <= 96 ? n : null;
}

const objectOf = (v: unknown): Design => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Design) } : {});

function DesignTokensSection({ definition, onCommit, disabled }: ThemeSectionProps) {
    const { t } = useTranslation();
    const [draftName, setDraftName] = useState('');
    const [draftValue, setDraftValue] = useState('');
    const design = (definition?.design || {}) as Design;
    const tokens = objectOf(design.tokens);
    const dark = objectOf(design.dark);
    const commit = (patch: Design) => {
        const def = updateDesign(definition, { ...patch, preset: 'custom' });
        if (def !== definition) onCommit(def);
    };
    const setTokens = (next: Design) => commit({ tokens: Object.keys(next).length ? next : null });
    const setDark = (key: string, value: string | null) => {
        const next = { ...dark };
        if (value) next[key] = value;
        else delete next[key];
        commit({ dark: Object.keys(next).length ? next : null });
    };
    const draftOk = isTokenName(draftName) && parseTokenValue(draftValue) !== null;
    const labels: Record<string, string> = {
        primary: t('studio_apps_lk16.dark.primary', 'Primary on dark'),
        accent: t('studio_apps_lk16.dark.accent', 'Accent on dark'),
        canvas: t('studio_apps_lk16.dark.canvas', 'Page ground on dark'),
    };

    return (
        <div data-testid="design-tokens-settings" className="flex flex-col gap-3">
            <SectionTitle>{t('studio_apps_lk16.tokens.title', 'Tokens')}</SectionTitle>
            {Object.entries(tokens).map(([name, value]) => (
                <div key={name} className="flex items-center gap-2 text-xs" data-testid="design-token-row">
                    <code className="flex-1 truncate">token:{name}</code>
                    <span className="text-[var(--text-secondary)]">{String(value)}</span>
                    <button type="button" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]" disabled={disabled} onClick={() => { const next = { ...tokens }; delete next[name]; setTokens(next); }}>
                        {t('studio_apps_lk16.tokens.remove', 'Remove')}
                    </button>
                </div>
            ))}
            <TextField label={t('studio_apps_lk16.tokens.name', 'Token name')} value={draftName} onChange={setDraftName} placeholder={t('studio_apps_lk16.tokens.name_placeholder', 'brand-soft')} disabled={disabled} />
            <TextField label={t('studio_apps_lk16.tokens.value', 'Colour (#rrggbb) or spacing in pixels')} value={draftValue} onChange={setDraftValue} placeholder="#e0f2fe" disabled={disabled} />
            <button
                type="button"
                className="self-start text-xs font-medium text-[var(--text-primary)] disabled:opacity-50"
                disabled={disabled || !draftOk}
                onClick={() => { setTokens({ ...tokens, [draftName]: parseTokenValue(draftValue) }); setDraftName(''); setDraftValue(''); }}
            >
                {t('studio_apps_lk16.tokens.add', 'Add token')}
            </button>
            <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_lk16.tokens.hint', 'Use a colour token in a colour knob as token:<name>; every token is also the CSS variable --app-token-<name>.')}</p>
            <NumberField
                label={t('studio_apps_lk16.radius.label', 'Corner radius (px)')}
                value={typeof design.radiusPx === 'number' ? design.radiusPx : null}
                onChange={(v) => commit({ radiusPx: v === null ? null : Math.min(32, Math.max(0, Math.round(v))) })}
                placeholder={t('studio_apps_lk16.radius.placeholder', 'From the theme')}
                disabled={disabled}
            />
            <SectionTitle>{t('studio_apps_lk16.dark.title', 'Dark palette')}</SectionTitle>
            {DARK_KEYS.map((key) => (
                <div key={key} className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">{labels[key]}</span>
                    <HexColourField value={typeof dark[key] === 'string' ? String(dark[key]) : ''} fallback="#1a1a24" onPick={(c) => { if (!disabled) setDark(key, c); }} label={labels[key]} />
                    {dark[key] ? (
                        <button type="button" className="self-start text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]" disabled={disabled} onClick={() => setDark(key, null)}>
                            {t('studio_apps_lk16.dark.clear', 'Use the theme colour')}
                        </button>
                    ) : null}
                </div>
            ))}
            <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_lk16.dark.hint', 'Used while the app is dark; not under the high-contrast theme.')}</p>
        </div>
    );
}

const entry: ThemeSectionEntry = { order: 30, Section: DesignTokensSection };
export default entry;
