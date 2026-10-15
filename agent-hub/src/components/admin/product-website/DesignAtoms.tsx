import { contrastRatio } from './controls/colorUtils';
import { FieldRow } from './fields';
import { fontStack } from './googleFonts';
import { useTranslation } from '../../../hooks/useTranslation';
import type { CmsDesign, ThemePresetLike } from './DesignEditor.types';

// ── small UI atoms (kept local so the panel stays as the only consumer) ──

// Pure-CSS mini site painted from the preset's own values — honest
// preview, no iframe. Dark presets preview their dark palette.
interface PresetCardProps {
    preset: ThemePresetLike;
    active: boolean;
    onApply: () => void;
}

export function PresetCard({ preset, active, onApply }: PresetCardProps) {
    const { t } = useTranslation();
    const p = preset.design;
    const dark = p.theme === 'dark';
    const bg      = dark ? p.darkColors.background   : p.colors.background;
    const surface = dark ? p.darkColors.surface      : p.colors.surface;
    const text    = dark ? p.darkColors.textPrimary  : p.colors.textPrimary;
    const muted   = dark ? p.darkColors.textSecondary : p.colors.textSecondary;
    const line = (w: number | string, c: string | undefined, h = 5) => (
        <div style={{ width: w, height: h, borderRadius: 3, background: c }} />
    );

    // Preview the SHAPE decisions too, not just color + heading font —
    // otherwise eight themes look nearly identical in the gallery.
    const comp = p.components || {};
    const btnRadius: number = ({ pill: 999, soft: 8, rounded: 3, sharp: 0 } as Record<string, number>)[comp.buttonShape as string] ?? 8;
    const cardRadius = comp.cardStyle === 'soft' ? 7 : comp.buttonShape === 'sharp' ? 0 : 4;
    const floating = comp.navStyle === 'floating';
    const cardBorder = comp.cardStyle === 'flat' ? 'none' : `1px solid ${muted}33`;
    const cardShadow = comp.cardStyle === 'elevated' ? `0 2px 5px ${muted}44` : 'none';
    const btnFg = comp.buttonTextColor === 'dark' ? '#0B0B0C' : '#fff';

    return (
        <button
            type="button"
            onClick={onApply}
            title={preset.description}
            className={`text-left rounded-lg border transition-colors ${active
                ? 'border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]'
                : 'border-[var(--border-default)] hover:border-[var(--text-muted)]'}`}
        >
            <div style={{ background: bg, borderRadius: '7px 7px 0 0', padding: 10 }}>
                {/* mini header — floating themes show a detached inset pill */}
                <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    marginBottom: 8,
                    ...(floating ? {
                        background: surface,
                        border: `1px solid ${muted}33`,
                        borderRadius: 999,
                        padding: '3px 6px',
                        margin: '0 3px 8px',
                    } : {}),
                    ...(comp.navStyle === 'bordered' ? {
                        borderBottom: `1px solid ${muted}44`,
                        paddingBottom: 5,
                    } : {}),
                }}>
                    {line(20, text, 4)}
                    <div style={{
                        width: 20, height: 7,
                        borderRadius: Math.min(btnRadius, 4),
                        background: p.gradient
                            ? `linear-gradient(135deg, ${p.colors.primary}, ${p.colors.accent})`
                            : p.colors.primary,
                    }} />
                </div>
                {/* mini hero */}
                <div style={{ fontFamily: fontStack(p.fonts.heading), color: text, fontSize: 11, fontWeight: p.typography.headingWeight, lineHeight: 1.15, marginBottom: 5 }}>
                    {t('cms_site.site.design.sample_headline', 'Your AI. Your rules.')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 }}>
                    {line('80%', muted, 3)}
                    {line('62%', muted, 3)}
                </div>
                {/* mini CTA — carries the button shape + label color */}
                <div style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    height: 13, padding: '0 9px', marginBottom: 7,
                    borderRadius: btnRadius,
                    background: p.gradient
                        ? `linear-gradient(135deg, ${p.colors.primary}, ${p.colors.accent})`
                        : p.colors.primary,
                    color: btnFg, fontSize: 7, fontWeight: 600,
                    fontFamily: fontStack(p.fonts.body),
                }}>
                    {t('cms_site.site.design.sample_button', 'Get started')}
                </div>
                {/* mini cards — carry the card recipe */}
                <div style={{ display: 'flex', gap: 4 }}>
                    <div style={{ flex: 1, height: 16, borderRadius: cardRadius, background: surface, border: cardBorder, boxShadow: cardShadow }} />
                    <div style={{ flex: 1, height: 16, borderRadius: cardRadius, background: surface, border: cardBorder, boxShadow: cardShadow }} />
                </div>
            </div>
            <div className="px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-primary)] flex items-center justify-between">
                {preset.label}
                {active ? <span className="text-[10px] text-[var(--accent-primary)]">{t('cms_site.site.design.active', 'Active')}</span> : null}
            </div>
        </button>
    );
}

// Advisory WCAG contrast hint — warns, never blocks.
interface ContrastBadgeProps {
    fg: string | undefined;
    bg: string | undefined;
    label: string;
}

export function ContrastBadge({ fg, bg, label }: ContrastBadgeProps) {
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

// One-glance pairing check: display / heading / body / eyebrow samples in
// the chosen faces on the chosen background.
export function TypeScalePreview({ design }: { design: CmsDesign }) {
    const { t } = useTranslation();
    const bg = design.theme === 'dark'
        ? (design.darkColors?.background || '#101012')
        : design.colors.background;
    const text = design.theme === 'dark'
        ? (design.darkColors?.textPrimary || '#F4F2EE')
        : design.colors.textPrimary;
    const muted = design.theme === 'dark'
        ? (design.darkColors?.textSecondary || '#A6A29A')
        : design.colors.textSecondary;
    const weight = design.typography?.headingWeight || 600;
    return (
        <div className="rounded-md border border-[var(--border-default)] overflow-hidden mb-2">
            <div style={{ background: bg, padding: '12px 14px' }}>
                <div style={{ fontFamily: fontStack(design.fonts.heading), fontWeight: weight, fontSize: 22, lineHeight: 1.1, letterSpacing: '-0.02em', color: text }}>
                    {t('cms_site.site.design.display_headline', 'Display headline')}
                </div>
                <div style={{ fontFamily: fontStack(design.fonts.heading), fontWeight: weight, fontSize: 14, marginTop: 6, color: text }}>
                    {t('cms_site.site.design.section_heading', 'Section heading')}
                </div>
                <div style={{ fontFamily: fontStack(design.fonts.body), fontSize: 11, lineHeight: 1.5, marginTop: 6, color: muted }}>
                    {t('cms_site.site.design.body_copy', 'Body copy set in the paragraph face, sized for reading.')}
                </div>
                <div style={{ fontFamily: fontStack(design.fonts.mono || 'IBM Plex Mono'), fontSize: 8.5, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 7, color: muted }}>
                    {t('cms_site.site.design.eyebrow', '01 — Eyebrow label')}
                </div>
            </div>
        </div>
    );
}

export function RadiusRow({ value, onChange }: { value?: number; onChange: (v: number) => void }) {
    const v = typeof value === 'number' ? value : 12;
    return (
        <FieldRow label={`Border radius — ${v}px`} hint="Affects buttons, cards, and inputs across the site.">
            <div className="flex items-center gap-3">
                <input
                    type="range"
                    min="0"
                    max="24"
                    step="1"
                    value={v}
                    onChange={(e) => onChange(parseInt(e.target.value, 10))}
                    className="flex-1 accent-[var(--accent-primary)]"
                />
                <span
                    className="shrink-0 inline-block bg-[var(--accent-primary)]"
                    style={{ width: 28, height: 28, borderRadius: `${v}px` }}
                    title={`${v}px preview`}
                />
            </div>
        </FieldRow>
    );
}
