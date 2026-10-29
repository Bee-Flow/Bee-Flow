import DarkBandControl from './DarkBandControl';
import DisplayTrackingControl from './DisplayTrackingControl';
import { contrastRatio } from './colorUtils';
import { FieldRow } from '../fields';
import { SectionDivider, ColorRow, SegmentedControl } from '../primitives';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { DesignColors, DesignComponents, DesignTypography } from '@/marketing/ProductWebsite.types';

// Sections of the Design tab (DesignEditor): brand colours, the dark palette,
// typography and navigation, and the contrast hint they share.

// Advisory WCAG contrast hint — warns, never blocks.
export function ContrastBadge({ fg, bg, label }: { fg?: string | null; bg?: string | null; label: string }) {
    const ratio = contrastRatio(fg, bg);
    if (ratio === null) return null;
    const rounded = Math.round(ratio * 10) / 10;
    const good = ratio >= 4.5;
    const okLarge = ratio >= 3;
    const tone = good ? 'text-emerald-600' : okLarge ? 'text-amber-500' : 'text-red-500';
    const verdict = good ? 'AA' : okLarge ? 'AA (large text only)' : 'Low contrast';
    return (
        <div className={`-mt-1 mb-2 text-[10px] ${tone}`} title={label}>
            {verdict} · {rounded}:1{good ? '' : ` — ${label} may be hard to read`}
        </div>
    );
}

/** The brand colours, each text colour with its contrast against the background. */
export function BrandColorsSection({ colors, setColor }: { colors: DesignColors; setColor: (key: keyof DesignColors, value: string) => void }) {
    return (
        <>
            <SectionDivider label="Brand colors" />
            <ColorRow label="Primary"        value={colors.primary}       onChange={v => setColor('primary',       v)} hint="Buttons, links, accents" />
            <ColorRow label="Secondary"      value={colors.secondary}     onChange={v => setColor('secondary',     v)} hint="Strong contrast / dark blocks" />
            <ColorRow label="Accent"         value={colors.accent}        onChange={v => setColor('accent',        v)} hint="Highlights, badges" />
            <ColorRow label="Background"     value={colors.background}    onChange={v => setColor('background',    v)} hint="Page background" />
            <ColorRow label="Surface"        value={colors.surface}       onChange={v => setColor('surface',       v)} hint="Cards, alternating sections" />
            <ColorRow label="Text"           value={colors.textPrimary}   onChange={v => setColor('textPrimary',   v)} hint="Body copy" />
            <ContrastBadge fg={colors.textPrimary} bg={colors.background} label="Body text on background" />
            <ColorRow label="Text secondary" value={colors.textSecondary} onChange={v => setColor('textSecondary', v)} hint="Muted / supporting copy" />
            <ContrastBadge fg={colors.textSecondary} bg={colors.background} label="Muted text on background" />
            <ContrastBadge fg="#FFFFFF" bg={colors.primary} label="Button text on primary" />
        </>
    );
}

interface DarkPaletteSectionProps {
    t: TranslateFn;
    dk: Partial<DesignColors>;
    setDarkColor: (key: keyof DesignColors, value: string) => void;
    darkBand: string | undefined;
    onDarkBand: (value: string) => void;
}

/** The dark-mode palette, its optional brand overrides, and the dark band. */
export function DarkPaletteSection({ t, dk, setDarkColor, darkBand, onDarkBand }: DarkPaletteSectionProps) {
    return (
        <>
            <SectionDivider label={t('cms_site.site.design.dark_palette', 'Dark mode palette')} />
            <p className="text-[11px] text-[var(--text-muted)] mb-2">
                {t('cms_site.site.design.dark_help', 'Used while the site (or a visitor) is in dark mode. Brand colors above stay the same in both modes.')}
            </p>
            <ColorRow label="Background"     value={dk.background    || ''} onChange={v => setDarkColor('background',    v)} hint="Dark page background" />
            <ColorRow label="Surface"        value={dk.surface       || ''} onChange={v => setDarkColor('surface',       v)} hint="Dark cards / bands" />
            <ColorRow label="Text"           value={dk.textPrimary   || ''} onChange={v => setDarkColor('textPrimary',   v)} hint="Dark-mode body copy" />
            <ContrastBadge fg={dk.textPrimary} bg={dk.background} label="Dark body text on dark background" />
            <ColorRow label="Text secondary" value={dk.textSecondary || ''} onChange={v => setDarkColor('textSecondary', v)} hint="Dark-mode muted copy" />
            {/* In the schema and honored by the renderer; these are their controls. */}
            <ColorRow label="Primary override" value={dk.primary || ''} onChange={v => setDarkColor('primary', v)} hint="Optional. Leave empty to reuse the light-mode Primary in dark mode." />
            <ColorRow label="Accent override"  value={dk.accent  || ''} onChange={v => setDarkColor('accent',  v)} hint="Optional. Leave empty to reuse the light-mode Accent." />
            <DarkBandControl value={darkBand} onChange={onDarkBand} />
        </>
    );
}

/** Hero display size, heading weight, display tracking and body size. */
export function TypographySection({ ty, setTypography }: { ty: DesignTypography; setTypography: (key: 'displaySize' | 'headingWeight' | 'displayTracking' | 'bodySize', value: string | number) => void }) {
    return (
        <>
            <SectionDivider label="Typography" />
            <FieldRow label="Hero display size" hint="Caps how large the hero headline can grow on wide screens.">
                <SegmentedControl
                    value={ty.displaySize || 'lg'}
                    onChange={v => setTypography('displaySize', v)}
                    options={[
                        { value: 'md', label: '64px' },
                        { value: 'lg', label: '80px' },
                        { value: 'xl', label: '96px' },
                    ]}
                />
            </FieldRow>
            <FieldRow label="Heading weight" hint="Premium sites keep headings at 500–600, never heavy bold.">
                <SegmentedControl
                    value={String(ty.headingWeight || 600)}
                    onChange={v => setTypography('headingWeight', Number(v))}
                    options={[500, 600, 700, 800, 900].map(w => ({ value: String(w), label: String(w) }))}
                />
            </FieldRow>
            <DisplayTrackingControl value={ty.displayTracking} onChange={v => setTypography('displayTracking', v)} />
            <FieldRow label="Body size">
                <SegmentedControl
                    value={String(ty.bodySize || 16)}
                    onChange={v => setTypography('bodySize', Number(v))}
                    options={[
                        { value: '16', label: '16px' },
                        { value: '17', label: '17px' },
                        { value: '18', label: '18px' },
                    ]}
                />
            </FieldRow>
        </>
    );
}

/** Navigation style, height and logo size. */
export function NavigationSection({ cp, setComponent }: { cp: DesignComponents; setComponent: (key: string, value: string) => void }) {
    return (
        <>
            <SectionDivider label="Navigation" />
            <FieldRow label="Style" hint="Floating detaches the bar into a rounded pill and swaps the underline hover for a chip.">
                <SegmentedControl
                    value={cp.navStyle || 'bar'}
                    onChange={v => setComponent('navStyle', v)}
                    options={[
                        { value: 'bar',      label: 'Bar' },
                        { value: 'floating', label: 'Floating' },
                        { value: 'bordered', label: 'Bordered' },
                    ]}
                />
            </FieldRow>
            <FieldRow label="Height">
                <SegmentedControl
                    value={cp.navHeight || 'default'}
                    onChange={v => setComponent('navHeight', v)}
                    options={[
                        { value: 'compact', label: '60px' },
                        { value: 'default', label: '72px' },
                        { value: 'tall',    label: '88px' },
                    ]}
                />
            </FieldRow>
            <FieldRow label="Logo size">
                <SegmentedControl
                    value={cp.logoSize || 'md'}
                    onChange={v => setComponent('logoSize', v)}
                    options={[
                        { value: 'sm', label: 'Small' },
                        { value: 'md', label: 'Medium' },
                        { value: 'lg', label: 'Large' },
                    ]}
                />
            </FieldRow>
        </>
    );
}
