import React, { useEffect } from 'react';
import { contrastRatio } from './controls/colorUtils';
import { Toggle, ImageField, FieldRow } from './fields';
import { GOOGLE_FONTS, buildFontsHrefs, fontStack } from './googleFonts';
import { SectionDivider, ColorRow, FontRow, SegmentedControl, FieldSelect } from './primitives';
import { THEME_PRESETS, applyPreset } from './themePresets';
import { FALLBACK_DESIGN } from './DesignEditor.defaults';
import { ContrastBadge, PresetCard, RadiusRow, TypeScalePreview } from './DesignAtoms';
import type { CmsDesign, DesignColors, DesignComponents, DesignDarkColors, DesignFonts, DesignLayout, DesignTypography, ThemePresetLike } from './DesignEditor.types';
import { AppIcon } from './blog/jsComponents';
import useConfirm from '../../shared/useConfirm';
// Self-hosted Fontshare @font-face — needed here so the picker's
// dropdown previews render in the chosen face. Same CSS file the
// iframe imports via ProductWebsite.jsx.
import '../../../marketing/self-hosted-fonts.css';
import { useTranslation } from '../../../hooks/useTranslation';

// ColorRow / FontRow used to be defined here; they now live in
// ./primitives. Re-export so existing imports from this module
// (editors barrel, other panels) keep resolving.
export { ColorRow, FontRow } from './primitives';

/**
 * Design tab — site-wide branding controls.
 *
 * Edits flow back to the parent through `onChange(nextDesign)`. The
 * panel merges the result into `site.design` and pushes through the
 * shared `scheduleSave('site', ...)` flow, so design saves coalesce
 * with chrome saves into a single SiteDoc PUT (no race window).
 *
 * Default values come from the backend payload, so this component
 * never needs to invent a starting design — but we apply a light
 * fallback locally so the controls still render if the prop is null.
 */


interface DesignEditorProps {
    design?: CmsDesign | null;
    onChange: (next: CmsDesign) => void;
}

export default function DesignEditor({ design, onChange }: DesignEditorProps) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const d = design || FALLBACK_DESIGN;

    // Preload the curated font library at regular + semibold weights in
    // the parent window so the in-panel previews render in the chosen
    // face. The iframe loads its own (larger) bundle of weights
    // independently. One <link> per source (Google + Fontshare) because
    // the CDNs use different URL formats.
    useEffect(() => {
        const hrefs = buildFontsHrefs(GOOGLE_FONTS, [400, 600]);
        for (const { id, href } of hrefs) {
            if (document.getElementById(id)) continue;
            const link = document.createElement('link');
            link.id = id;
            link.rel = 'stylesheet';
            link.href = href;
            document.head.appendChild(link);
        }
        // Don't remove on unmount — keeps fonts cached across tab switches.
    }, []);

    const setColor = (key: keyof DesignColors, value: string) =>
        onChange({ ...d, colors: { ...d.colors, [key]: value } });
    const setDarkColor = (key: keyof DesignDarkColors, value: string) =>
        onChange({ ...d, darkColors: { ...(d.darkColors || {}), [key]: value } });
    const setFont = (key: keyof DesignFonts, value: string) =>
        onChange({ ...d, fonts: { ...d.fonts, [key]: value } });
    const setTypography = (key: keyof DesignTypography, value: string | number) =>
        onChange({ ...d, typography: { ...(d.typography || {}), [key]: value } });
    const setComponent = (key: keyof DesignComponents, value: string) =>
        onChange({ ...d, components: { ...(d.components || {}), [key]: value } });
    const setLayout = (key: keyof DesignLayout, value: string) =>
        onChange({ ...d, layout: { ...(d.layout || {}), [key]: value } });
    const setRadius   = (value: number) => onChange({ ...d, radius: value });
    const setTheme    = (isDark: boolean) => onChange({ ...d, theme: isDark ? 'dark' : 'light' });
    const setGradient = (on: boolean) => onChange({ ...d, gradient: !!on });
    const setLogo     = (value: string) => onChange({ ...d, logo: value });
    const setFavicon  = (value: string) => onChange({ ...d, favicon: value });

    const dk = d.darkColors || {};
    const ty = d.typography || {};
    const cp = d.components || {};
    const ly = d.layout || {};

    const handlePreset = async (preset: ThemePresetLike) => {
        // One object write → one history entry + one 'site' save; the
        // confirm matters because this replaces 10+ fields at once.
        if (!(await confirm({ title: `Apply the "${preset.label}" theme?`, description: 'This replaces your colors, fonts, and typography (logo and favicon are kept). You can undo with Ctrl+Z.', confirmLabel: 'Apply theme' }))) return;
        onChange(applyPreset(d, preset));
    };

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="px-4 pt-4 pb-6">
                <div className="flex items-center gap-2 mb-1">
                    <AppIcon name="Palette" className="w-4 h-4 text-[var(--accent-primary)]" />
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{t('cms_site.site.design.title', 'Design')}</span>
                </div>
                <p className="text-xs text-[var(--text-muted)] mb-4">
                    {t('cms_site.site.design.intro', 'Site-wide brand colors, fonts, and shape. Applied to every page in this site.')}
                </p>

                <SectionDivider label="Theme presets" />
                <div className="grid grid-cols-2 gap-2 mb-3">
                    {THEME_PRESETS.map(p => (
                        <PresetCard
                            key={p.id}
                            preset={p}
                            active={d.preset === p.id}
                            onApply={() => handlePreset(p)}
                        />
                    ))}
                </div>

                <SectionDivider label="Brand colors" />
                <ColorRow label="Primary"        value={d.colors.primary}       onChange={(v: string) => setColor('primary',       v)} hint="Buttons, links, accents" />
                <ColorRow label="Secondary"      value={d.colors.secondary}     onChange={(v: string) => setColor('secondary',     v)} hint="Strong contrast / dark blocks" />
                <ColorRow label="Accent"         value={d.colors.accent}        onChange={(v: string) => setColor('accent',        v)} hint="Highlights, badges" />
                <ColorRow label="Background"     value={d.colors.background}    onChange={(v: string) => setColor('background',    v)} hint="Page background" />
                <ColorRow label="Surface"        value={d.colors.surface}       onChange={(v: string) => setColor('surface',       v)} hint="Cards, alternating sections" />
                <ColorRow label="Text"           value={d.colors.textPrimary}   onChange={(v: string) => setColor('textPrimary',   v)} hint="Body copy" />
                <ContrastBadge fg={d.colors.textPrimary} bg={d.colors.background} label="Body text on background" />
                <ColorRow label="Text secondary" value={d.colors.textSecondary} onChange={(v: string) => setColor('textSecondary', v)} hint="Muted / supporting copy" />
                <ContrastBadge fg={d.colors.textSecondary} bg={d.colors.background} label="Muted text on background" />
                <ContrastBadge fg="#FFFFFF" bg={d.colors.primary} label="Button text on primary" />

                <SectionDivider label={t('cms_site.site.design.dark_palette', 'Dark mode palette')} />
                <p className="text-[11px] text-[var(--text-muted)] mb-2">
                    {t('cms_site.site.design.dark_help', 'Used while the site (or a visitor) is in dark mode. Brand colors above stay the same in both modes.')}
                </p>
                <ColorRow label="Background"     value={dk.background    || ''} onChange={(v: string) => setDarkColor('background',    v)} hint="Dark page background" />
                <ColorRow label="Surface"        value={dk.surface       || ''} onChange={(v: string) => setDarkColor('surface',       v)} hint="Dark cards / bands" />
                <ColorRow label="Text"           value={dk.textPrimary   || ''} onChange={(v: string) => setDarkColor('textPrimary',   v)} hint="Dark-mode body copy" />
                <ContrastBadge fg={dk.textPrimary} bg={dk.background} label="Dark body text on dark background" />
                <ColorRow label="Text secondary" value={dk.textSecondary || ''} onChange={(v: string) => setDarkColor('textSecondary', v)} hint="Dark-mode muted copy" />
                {/* These two were already in the schema, sanitized and honored
                    by the renderer, but had no control until now. */}
                <ColorRow label="Primary override" value={dk.primary || ''} onChange={(v: string) => setDarkColor('primary', v)} hint="Optional. Leave empty to reuse the light-mode Primary in dark mode." />
                <ColorRow label="Accent override"  value={dk.accent  || ''} onChange={(v: string) => setDarkColor('accent',  v)} hint="Optional. Leave empty to reuse the light-mode Accent." />

                <SectionDivider label="Fonts" />
                <FontRow label="Heading font" value={d.fonts.heading} onChange={(v: string) => setFont('heading', v)} sample="The quick brown fox jumps" weight={600} />
                <FontRow label="Body font"    value={d.fonts.body}    onChange={(v: string) => setFont('body',    v)} sample="The quick brown fox jumps over the lazy dog. 0123456789" weight={400} />
                <FontRow label="Mono font"    value={d.fonts.mono || 'IBM Plex Mono'} onChange={(v: string) => setFont('mono', v)} sample="01 — PRIVATE BY DESIGN" weight={500} />
                <TypeScalePreview design={d} />

                <SectionDivider label="Typography" />
                <FieldRow label="Hero display size" hint="Caps how large the hero headline can grow on wide screens.">
                    <SegmentedControl iconOnly={undefined}
                        value={ty.displaySize || 'lg'}
                        onChange={(v: string) => setTypography('displaySize', v)}
                        options={[
                            { value: 'md', label: '64px' },
                            { value: 'lg', label: '80px' },
                            { value: 'xl', label: '96px' },
                        ]}
                    />
                </FieldRow>
                <FieldRow label="Heading weight" hint="Premium sites keep headings at 500–600, never heavy bold.">
                    <SegmentedControl iconOnly={undefined}
                        value={String(ty.headingWeight || 600)}
                        onChange={(v: string) => setTypography('headingWeight', Number(v))}
                        options={[
                            { value: '500', label: '500' },
                            { value: '600', label: '600' },
                            { value: '700', label: '700' },
                        ]}
                    />
                </FieldRow>
                <FieldRow label="Body size">
                    <SegmentedControl iconOnly={undefined}
                        value={String(ty.bodySize || 16)}
                        onChange={(v: string) => setTypography('bodySize', Number(v))}
                        options={[
                            { value: '16', label: '16px' },
                            { value: '17', label: '17px' },
                            { value: '18', label: '18px' },
                        ]}
                    />
                </FieldRow>

                <SectionDivider label="Motion & texture" />
                <FieldSelect hint={undefined}
                    label="Motion level"
                    value={d.motion && ['none', 'subtle', 'full'].includes(d.motion) ? d.motion : 'full'}
                    options={[
                        { value: 'full',   label: 'Full — reveals, ambience, marquee' },
                        { value: 'subtle', label: 'Subtle — quiet reveals only' },
                        { value: 'none',   label: 'None — completely static' },
                    ]}
                    onChange={(v: string) => onChange({ ...d, motion: v })}
                />
                <FieldRow label="Grain texture" hint="A barely-visible film-grain overlay — adds tactility to flat color fields.">
                    <Toggle label={d.grain ? 'On' : 'Off'} value={d.grain === true} onChange={(v: boolean) => onChange({ ...d, grain: v === true })} />
                </FieldRow>

                <SectionDivider label="Logo & favicon" />
                <FieldRow label="Logo" hint="Replaces the letter-circle in the header (PNG/SVG, transparent background recommended)">
                    <ImageField value={d.logo} onChange={setLogo} />
                </FieldRow>
                <FieldRow label="Favicon" hint="Browser tab icon (PNG or ICO, square)">
                    <ImageField value={d.favicon} onChange={setFavicon} />
                </FieldRow>

                <SectionDivider label="Shape & theme" />
                <RadiusRow value={d.radius} onChange={setRadius} />
                <FieldRow label="Use gradient on primary" hint="When on, buttons and accents fade from Primary → Accent. When off, they're a flat solid Primary.">
                    <Toggle label={d.gradient ? 'Gradient' : 'Solid'} value={!!d.gradient} onChange={setGradient} />
                </FieldRow>
                <FieldRow label="Theme base" hint="Dark mode swaps Background, Surface, and Text colors with a dark layout palette. Your Primary, Secondary, and Accent stay as set.">
                    <Toggle label={d.theme === 'dark' ? 'Dark' : 'Light'} value={d.theme === 'dark'} onChange={setTheme} />
                </FieldRow>

                <SectionDivider label="Buttons" />
                <FieldRow label="Shape" hint="Sharp also flattens shadows and pills across the site — the whole flat idiom, not just square corners.">
                    <SegmentedControl iconOnly={undefined}
                        value={cp.buttonShape || 'soft'}
                        onChange={(v: string) => setComponent('buttonShape', v)}
                        options={[
                            { value: 'pill',    label: 'Pill' },
                            { value: 'soft',    label: 'Soft' },
                            { value: 'rounded', label: 'Rounded' },
                            { value: 'sharp',   label: 'Sharp' },
                        ]}
                    />
                </FieldRow>
                <FieldRow label="Size">
                    <SegmentedControl iconOnly={undefined}
                        value={cp.buttonSize || 'md'}
                        onChange={(v: string) => setComponent('buttonSize', v)}
                        options={[
                            { value: 'sm', label: 'Small' },
                            { value: 'md', label: 'Medium' },
                            { value: 'lg', label: 'Large' },
                        ]}
                    />
                </FieldRow>
                <FieldRow label="Label color" hint="White fails contrast on light brand colors like amber. 'Auto' picks black or white from your Primary's brightness.">
                    <SegmentedControl iconOnly={undefined}
                        value={cp.buttonTextColor || 'light'}
                        onChange={(v: string) => setComponent('buttonTextColor', v)}
                        options={[
                            { value: 'light', label: 'White' },
                            { value: 'dark',  label: 'Black' },
                            { value: 'auto',  label: 'Auto' },
                        ]}
                    />
                </FieldRow>
                <ContrastBadge
                    fg={cp.buttonTextColor === 'dark' ? '#0B0B0C' : '#FFFFFF'}
                    bg={d.colors.primary}
                    label="Button label on primary"
                />

                <SectionDivider label="Navigation" />
                <FieldRow label="Style" hint="Floating detaches the bar into a rounded pill and swaps the underline hover for a chip.">
                    <SegmentedControl iconOnly={undefined}
                        value={cp.navStyle || 'bar'}
                        onChange={(v: string) => setComponent('navStyle', v)}
                        options={[
                            { value: 'bar',      label: 'Bar' },
                            { value: 'floating', label: 'Floating' },
                            { value: 'bordered', label: 'Bordered' },
                        ]}
                    />
                </FieldRow>
                <FieldRow label="Height">
                    <SegmentedControl iconOnly={undefined}
                        value={cp.navHeight || 'default'}
                        onChange={(v: string) => setComponent('navHeight', v)}
                        options={[
                            { value: 'compact', label: '60px' },
                            { value: 'default', label: '72px' },
                            { value: 'tall',    label: '88px' },
                        ]}
                    />
                </FieldRow>
                <FieldRow label="Logo size">
                    <SegmentedControl iconOnly={undefined}
                        value={cp.logoSize || 'md'}
                        onChange={(v: string) => setComponent('logoSize', v)}
                        options={[
                            { value: 'sm', label: 'Small' },
                            { value: 'md', label: 'Medium' },
                            { value: 'lg', label: 'Large' },
                        ]}
                    />
                </FieldRow>

                <SectionDivider label="Cards" />
                <FieldRow label="Style" hint="Hairline = 1px border, no shadow. Flat = filled, borderless. Elevated = shadowed.">
                    <SegmentedControl iconOnly={undefined}
                        value={cp.cardStyle || 'hairline'}
                        onChange={(v: string) => setComponent('cardStyle', v)}
                        options={[
                            { value: 'hairline', label: 'Hairline' },
                            { value: 'soft',     label: 'Soft' },
                            { value: 'flat',     label: 'Flat' },
                            { value: 'elevated', label: 'Elevated' },
                        ]}
                    />
                </FieldRow>
                <FieldRow label="Padding">
                    <SegmentedControl iconOnly={undefined}
                        value={cp.cardPadding || 'default'}
                        onChange={(v: string) => setComponent('cardPadding', v)}
                        options={[
                            { value: 'compact', label: 'Compact' },
                            { value: 'default', label: 'Default' },
                            { value: 'roomy',   label: 'Roomy' },
                        ]}
                    />
                </FieldRow>
                <FieldRow label="Shadow depth">
                    <SegmentedControl iconOnly={undefined}
                        value={cp.shadow || 'soft'}
                        onChange={(v: string) => setComponent('shadow', v)}
                        options={[
                            { value: 'none',   label: 'None' },
                            { value: 'soft',   label: 'Soft' },
                            { value: 'medium', label: 'Medium' },
                            { value: 'strong', label: 'Strong' },
                        ]}
                    />
                </FieldRow>

                <SectionDivider label="Layout" />
                <FieldRow label="Content width" hint="The max width every section aligns to.">
                    <SegmentedControl iconOnly={undefined}
                        value={ly.containerWidth || 'default'}
                        onChange={(v: string) => setLayout('containerWidth', v)}
                        options={[
                            { value: 'narrow',  label: '1120' },
                            { value: 'default', label: '1280' },
                            { value: 'wide',    label: '1440' },
                            { value: 'full',    label: '1760' },
                        ]}
                    />
                </FieldRow>
                <FieldRow label="Section rhythm" hint="Site-wide vertical spacing between sections. Individual sections can still override this in their Style tab.">
                    <SegmentedControl iconOnly={undefined}
                        value={ly.sectionRhythm || 'default'}
                        onChange={(v: string) => setLayout('sectionRhythm', v)}
                        options={[
                            { value: 'tight',   label: 'Tight' },
                            { value: 'default', label: 'Default' },
                            { value: 'airy',    label: 'Airy' },
                        ]}
                    />
                </FieldRow>
            </div>
            {confirmDialog}
        </div>
    );
}
