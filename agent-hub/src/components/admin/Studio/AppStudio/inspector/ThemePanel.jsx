import React from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { TextField, TextAreaField, IconField } from './panels/kit';
import { SCREEN_DEFAULTS, SCREEN_ENUMS, THEME_ENUMS } from './styleKnobMeta';
import ColorPicker from '../../../../shared/ColorPicker';
import FormField from '../../../../shared/FormField';
import SegmentedControl from '../../../../shared/SegmentedControl';
import Toggle from '../../../../shared/Toggle';
import { NAV_STYLES, NAV_DEFAULT_STYLE, DESIGN_ENUMS, DESIGN_DEFAULTS } from '../runtime/appDesign';
import { APP_COLOR_PRESETS } from '../runtime/themeVars';
import { updateTheme, updateMeta, updateScreen, updateNav, updateDesign, updateAiBrowsing } from '../state/definitionOps';
import DesignPresetGallery from './DesignPresetGallery';

/**
 * ThemePanel — shown when nothing is selected: the whole-app knobs.
 * One color picker + four enums restyle the entire app (THEME_SPEC in
 * server/appStudio/componentSpecs.js is authoritative), plus the app meta
 * (name/description/icon) and the settings of the screen you are looking at.
 * Everything commits immediately through updateTheme/updateMeta/updateScreen
 * + onCommit.
 *
 * The screen block lives HERE rather than in ScreenTabs (a dense strip with a
 * kebab menu) because every other object in this editor is edited in the
 * right-hand inspector, and "nothing selected" already means "the thing you are
 * looking at". No new selection semantics, no reducer change.
 */

const enumLabels = (t) => ({
    none: t('studio_apps_insp.theme.enum_none', 'None'), sm: 'S', md: 'M', lg: 'L', xl: 'XL',
    compact: t('studio_apps_insp.theme.enum_compact', 'Compact'),
    comfortable: t('studio_apps_insp.theme.enum_comfortable', 'Comfy'),
    spacious: t('studio_apps_insp.theme.enum_spacious', 'Spacious'),
    light: t('studio_apps_insp.theme.enum_light', 'Light'),
    dark: t('studio_apps_insp.theme.enum_dark', 'Dark'),
    auto: t('studio_apps_insp.theme.enum_auto', 'Auto'),
    // App Design v2
    hairline: t('studio_apps_insp.theme.enum_hairline', 'Outline'),
    flat: t('studio_apps_insp.theme.enum_flat', 'Flat'),
    soft: t('studio_apps_insp.theme.enum_soft', 'Soft'),
    elevated: t('studio_apps_insp.theme.enum_elevated', 'Raised'),
    subtle: t('studio_apps_insp.theme.enum_subtle', 'Subtle'),
    full: t('studio_apps_insp.theme.enum_full', 'Full'),
    classic: t('studio_apps_insp.theme.enum_classic', 'Classic'),
    brand: t('studio_apps_insp.theme.enum_brand', 'Brand'),
});

const designFields = (t) => [
    { key: 'surface', label: t('studio_apps_insp.theme.design_surface', 'Surfaces'), hint: t('studio_apps_insp.theme.design_surface_hint', 'How cards, stats and grids sit on the page.') },
    { key: 'motion', label: t('studio_apps_insp.theme.design_motion', 'Motion'), hint: t('studio_apps_insp.theme.design_motion_hint', 'Animation level. Viewers who ask for reduced motion always get none.') },
    { key: 'chartPalette', label: t('studio_apps_insp.theme.design_chart_colours', 'Chart colours'), hint: t('studio_apps_insp.theme.design_chart_colours_hint', 'Brand derives chart colours from the primary colour.') },
];

// Typeface pairings. Self-hosted families load from our own server — no
// request to Google — which is worth saying out loud in a privacy product.
const fontLabels = (t) => ({
    system: t('studio_apps_insp.theme.font_system', 'System'), inter: 'Inter',
    satoshi: t('studio_apps_insp.theme.font_satoshi', 'Satoshi (local)'),
    'general-sans': t('studio_apps_insp.theme.font_general_sans', 'General Sans (local)'),
    cabinet: t('studio_apps_insp.theme.font_cabinet', 'Cabinet Grotesk (local)'),
    geist: 'Geist', plex: 'IBM Plex Sans', poppins: 'Poppins',
});

// Light grounds for the canvas picker — the platform's own off-white first,
// then warm/cool paper tones. A brand yellow is a custom hex away.
const CANVAS_PRESETS = ['#fafafa', '#f5f5f4', '#fef9c3', '#fff7ed', '#ecfdf5', '#eff6ff'];

const widthLabels = (t) => ({ narrow: 'S', medium: 'M', wide: 'L', full: t('studio_apps_insp.theme.enum_full', 'Full') });
const refreshLabels = (t) => ({ 0: t('studio_apps_insp.theme.refresh_off', 'Off'), 15: '15s', 30: '30s', 60: '1m', 300: '5m' });
const navStyleLabels = (t) => ({
    tabs: t('studio_apps_insp.theme.nav_tabs', 'Tabs'),
    sidebar: t('studio_apps_insp.theme.nav_sidebar', 'Sidebar'),
    mega: t('studio_apps_insp.theme.nav_mega', 'Mega'),
    rail: t('studio_apps_insp.theme.nav_rail', 'Rail'),
});

function options(t, values) {
    const labels = enumLabels(t);
    return values.map((v) => ({ value: v, label: labels[v] || v }));
}

const themeFields = (t) => [
    { key: 'radius', label: t('studio_apps_insp.theme.field_corners', 'Corners') },
    { key: 'density', label: t('studio_apps_insp.theme.field_density', 'Density') },
    { key: 'fontScale', label: t('studio_apps_insp.theme.field_text_size', 'Text size') },
    { key: 'appearance', label: t('studio_apps_insp.theme.field_appearance', 'Appearance') },
];

// Mirror of THEME_SPEC defaults (componentSpecs.js, authoritative).
const THEME_DEFAULTS = { radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' };

/**
 * One of the theme's OPTIONAL colours (accent, canvas): off means "unset" —
 * the consumer's own fallback applies — and on hands the picker a colour to
 * start from. Committing null is how the key clears (the canonicalizer then
 * drops it), so a theme that never chose stays byte-identical.
 */
function OptionalColorField({ label, hint, value, fallback, presets, onChange, disabled, ariaLabel }) {
    const { t } = useTranslation();
    const on = typeof value === 'string' && value.length > 0;
    return (
        <FormField label={label} hint={hint}>
            <div className="flex flex-col gap-2">
                <Toggle
                    checked={on}
                    onChange={(next) => onChange(next ? fallback : null)}
                    disabled={disabled}
                    ariaLabel={t('studio_apps_insp.theme.separate_colour_aria', '{label}: use a separate colour', { label: ariaLabel })}
                    size="sm"
                />
                {on ? (
                    <ColorPicker
                        value={value}
                        onChange={onChange}
                        presets={presets}
                        allowCustom
                        disabled={disabled}
                        swatchSize={24}
                        ariaLabel={ariaLabel}
                    />
                ) : null}
            </div>
        </FormField>
    );
}

function SectionTitle({ children }) {
    return (
        <div className="flex items-center gap-2 mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{children}</span>
            <div className="flex-1 h-px bg-[var(--border-subtle)]" />
        </div>
    );
}

/**
 * The settings of the screen you are currently looking at. Extracted from
 * ThemePanel purely for length — it is only ever rendered there.
 */
function ScreenSettings({ screen, onCommit: commitScreen, disabled }) {
    const { t } = useTranslation();
    if (!screen) return null;
    return (
        <div data-testid="screen-settings">
            <SectionTitle>{t('studio_apps_insp.theme.this_screen', 'This screen')}</SectionTitle>
            <div className="flex flex-col gap-4">
                <FormField label={t('studio_apps_insp.theme.screen_width', 'Width')} hint={t('studio_apps_insp.theme.screen_width_hint', 'How much of the window the screen may use.')}>
                    <SegmentedControl
                        value={screen.maxWidth ?? SCREEN_DEFAULTS.maxWidth}
                        onChange={(v) => commitScreen({ maxWidth: v })}
                        options={SCREEN_ENUMS.maxWidth.map((v) => ({ value: v, label: widthLabels(t)[v] }))}
                        size="sm"
                        fullWidth
                        disabled={disabled}
                        ariaLabel={t('studio_apps_insp.theme.screen_width_aria', 'Screen width')}
                    />
                </FormField>
                <FormField label={t('studio_apps_insp.theme.auto_refresh', 'Auto-refresh')} hint={t('studio_apps_insp.theme.auto_refresh_hint', "Reload this screen's data in the background.")}>
                    <SegmentedControl
                        value={screen.refreshInterval ?? SCREEN_DEFAULTS.refreshInterval}
                        onChange={(v) => commitScreen({ refreshInterval: Number(v) })}
                        options={SCREEN_ENUMS.refreshInterval.map((v) => ({ value: v, label: refreshLabels(t)[v] }))}
                        size="sm"
                        fullWidth
                        disabled={disabled}
                        ariaLabel={t('studio_apps_insp.theme.auto_refresh_aria', 'Auto-refresh interval')}
                    />
                </FormField>
                <IconField
                    label={t('studio_apps_insp.theme.screen_icon', 'Screen icon')}
                    value={screen.icon}
                    onChange={(v) => commitScreen({ icon: v })}
                    disabled={disabled}
                />
                <TextField
                    label={t('studio_apps_insp.theme.menu_description', 'Menu description')}
                    value={screen.description || ''}
                    onChange={(v) => commitScreen({ description: v && v.trim() ? v.trim() : null })}
                    placeholder={t('studio_apps_insp.theme.menu_description_placeholder', 'Triage what came in today')}
                    disabled={disabled}
                />
                <FormField label={t('studio_apps_insp.theme.show_in_nav', 'Show in navigation')}>
                    <Toggle
                        checked={screen.showInNav !== false}
                        onChange={(v) => commitScreen({ showInNav: v })}
                        disabled={disabled}
                        ariaLabel={t('studio_apps_insp.theme.show_in_nav_aria', 'Show this screen in navigation')}
                    />
                </FormField>
            </div>
        </div>
    );
}

export default function ThemePanel({ definition, onCommit, disabled = false, screenId = null }) {
    const { t } = useTranslation();
    const theme = definition?.theme || {};
    const meta = definition?.meta || {};
    const design = definition?.design || {};
    const screen = (definition?.screens || []).find((s) => s.id === screenId) || null;

    const commitTheme = (patch) => {
        const next = updateTheme(definition, patch);
        if (next !== definition) onCommit(next);
    };
    const commitMeta = (patch) => {
        const next = updateMeta(definition, patch);
        if (next !== definition) onCommit(next);
    };
    const commitScreen = (patch) => {
        const next = updateScreen(definition, screenId, patch);
        if (next !== definition) onCommit(next);
    };
    const commitNav = (patch) => {
        const next = updateNav(definition, patch);
        if (next !== definition) onCommit(next);
    };
    const commitAiBrowsing = (patch) => {
        const next = updateAiBrowsing(definition, patch);
        if (next !== definition) onCommit(next);
    };
    // A design change makes the look the author's own — unless it IS a preset
    // being applied (that branch sets the provenance itself).
    const commitDesign = (patch) => {
        const next = updateDesign(definition, { ...design, ...patch, preset: 'custom' });
        if (next !== definition) onCommit(next);
    };
    // One commit for the whole look: theme + design + nav together, so undo is
    // a single step and the app never renders half a preset.
    const applyPreset = (preset) => {
        let next = updateTheme(definition, preset.theme);
        next = updateDesign(next, preset.design);
        next = updateNav(next, { style: preset.navStyle });
        if (next !== definition) onCommit(next);
    };

    return (
        <div className="p-4 flex flex-col gap-4" data-testid="theme-panel">
            <ScreenSettings screen={screen} onCommit={commitScreen} disabled={disabled} />

            <div>
                <SectionTitle>{t('studio_apps_insp.theme.look', 'Look')}</SectionTitle>
                <div className="flex flex-col gap-3">
                    <DesignPresetGallery
                        activePreset={design.preset || null}
                        onApply={applyPreset}
                        disabled={disabled}
                    />
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {design.preset && design.preset !== 'custom'
                            ? t('studio_apps_insp.theme.look_preset_active', 'A preset sets colour, corners, density, typeface, surfaces, motion and navigation in one go. Adjust anything below — it becomes your own look.')
                            : t('studio_apps_insp.theme.look_pick_start', 'Pick a starting point, then adjust anything below.')}
                    </p>
                </div>
            </div>

            <div>
                <SectionTitle>{t('studio_apps_insp.theme.app_theme', 'App theme')}</SectionTitle>
                <div className="flex flex-col gap-4">
                    <FormField label={t('studio_apps_insp.theme.primary_color', 'Primary color')}>
                        <ColorPicker
                            value={theme.primary || APP_COLOR_PRESETS[0]}
                            onChange={(hex) => commitTheme({ primary: hex })}
                            presets={APP_COLOR_PRESETS}
                            allowCustom
                            disabled={disabled}
                            swatchSize={24}
                            ariaLabel={t('studio_apps_insp.theme.primary_color_aria', 'Theme primary color')}
                        />
                    </FormField>
                    <OptionalColorField
                        label={t('studio_apps_insp.theme.button_colour', 'Button colour')}
                        hint={t('studio_apps_insp.theme.button_colour_hint', 'Primary buttons and form submits. Off = the primary colour.')}
                        value={theme.accent || null}
                        fallback={theme.primary || APP_COLOR_PRESETS[0]}
                        presets={APP_COLOR_PRESETS}
                        onChange={(hex) => commitTheme({ accent: hex })}
                        disabled={disabled}
                        ariaLabel={t('studio_apps_insp.theme.button_colour_aria', 'Theme button colour')}
                    />
                    <OptionalColorField
                        label={t('studio_apps_insp.theme.page_background', 'Page background')}
                        hint={t('studio_apps_insp.theme.page_background_hint', "The ground behind the sections. Off = the platform's own light or dark ground.")}
                        value={theme.canvas || null}
                        fallback={CANVAS_PRESETS[0]}
                        presets={CANVAS_PRESETS}
                        onChange={(hex) => commitTheme({ canvas: hex })}
                        disabled={disabled}
                        ariaLabel={t('studio_apps_insp.theme.page_background_aria', 'Theme page background')}
                    />
                    {themeFields(t).map(({ key, label }) => (
                        <FormField key={key} label={label}>
                            <SegmentedControl
                                value={theme[key] ?? THEME_DEFAULTS[key]}
                                onChange={(v) => commitTheme({ [key]: v })}
                                options={options(t, THEME_ENUMS[key])}
                                size="sm"
                                fullWidth
                                disabled={disabled}
                                ariaLabel={label}
                            />
                        </FormField>
                    ))}
                </div>
            </div>

            <div>
                <SectionTitle>{t('studio_apps_insp.theme.design', 'Design')}</SectionTitle>
                <div className="flex flex-col gap-4">
                    <FormField label={t('studio_apps_insp.theme.typeface', 'Typeface')} hint={t('studio_apps_insp.theme.typeface_hint', '“(local)” fonts are served from Bee Flow itself — no request leaves the browser.')}>
                        <select
                            value={design.font ?? DESIGN_DEFAULTS.font}
                            onChange={(e) => commitDesign({ font: e.target.value })}
                            disabled={disabled}
                            aria-label={t('studio_apps_insp.theme.typeface', 'Typeface')}
                            className="w-full border px-2 py-1.5 text-sm outline-none focus:border-[var(--app-primary)] disabled:opacity-50"
                            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', borderRadius: '6px', color: 'var(--text-primary)' }}
                        >
                            {DESIGN_ENUMS.font.map((v) => (
                                <option key={v} value={v}>{fontLabels(t)[v] || v}</option>
                            ))}
                        </select>
                    </FormField>
                    {designFields(t).map(({ key, label, hint }) => (
                        <FormField key={key} label={label} hint={hint}>
                            <SegmentedControl
                                value={design[key] ?? DESIGN_DEFAULTS[key]}
                                onChange={(v) => commitDesign({ [key]: v })}
                                options={options(t, DESIGN_ENUMS[key])}
                                size="sm"
                                fullWidth
                                disabled={disabled}
                                ariaLabel={label}
                            />
                        </FormField>
                    ))}
                    <TextField
                        label={t('studio_apps_insp.theme.logo_url', 'Logo URL')}
                        value={design.logoUrl || ''}
                        onChange={(v) => commitDesign({ logoUrl: v && v.trim() ? v.trim() : null })}
                        placeholder={t('studio_apps_insp.theme.url_placeholder', 'https://…')}
                        disabled={disabled}
                    />
                </div>
            </div>

            <div>
                <SectionTitle>{t('studio_apps_insp.theme.navigation', 'Navigation')}</SectionTitle>
                <div className="flex flex-col gap-4">
                    <FormField
                        label={t('studio_apps_insp.theme.nav_style', 'Style')}
                        hint={t('studio_apps_insp.theme.nav_style_hint', "Tabs along the top, a sidebar or an icon rail on the left, or Mega — a top bar whose groups open a panel with a description per screen. Group screens via the screen strip's menu; Mega needs at least one group.")}
                    >
                        <SegmentedControl
                            value={NAV_STYLES.includes(definition?.nav?.style) ? definition.nav.style : NAV_DEFAULT_STYLE}
                            onChange={(v) => commitNav({ style: v })}
                            options={NAV_STYLES.map((v) => ({ value: v, label: navStyleLabels(t)[v] || v }))}
                            size="sm"
                            fullWidth
                            disabled={disabled}
                            ariaLabel={t('studio_apps_insp.theme.nav_style_aria', 'Navigation style')}
                        />
                    </FormField>
                </div>
            </div>

            <div>
                <SectionTitle>{t('studio_apps_insp.theme.app', 'App')}</SectionTitle>
                <div className="flex flex-col gap-4">
                    <TextField
                        label={t('studio_apps_insp.theme.name', 'Name')}
                        value={meta.name}
                        onChange={(v) => commitMeta({ name: v })}
                        placeholder={t('studio_apps_insp.theme.name_placeholder', 'Untitled app')}
                        disabled={disabled}
                    />
                    <TextAreaField
                        label={t('studio_apps_insp.theme.description', 'Description')}
                        value={meta.description}
                        onChange={(v) => commitMeta({ description: v })}
                        placeholder={t('studio_apps_insp.theme.description_placeholder', 'What does this app do?')}
                        rows={3}
                        disabled={disabled}
                    />
                    <IconField
                        label={t('studio_apps_insp.theme.icon', 'Icon')}
                        value={meta.icon}
                        onChange={(v) => commitMeta({ icon: v })}
                        disabled={disabled}
                    />
                </div>
            </div>

            <AiBrowsingSettings
                value={definition?.aiBrowsing || null}
                onCommit={commitAiBrowsing}
                disabled={disabled}
            />
        </div>
    );
}

/**
 * AI browsing — the OWNER's switch.
 *
 * An `ai_browse` step drives a real headless browser as the app owner. The AI
 * that authors the app can add such a step, but it can never switch this on:
 * the key is absent from the builder tool schemas on purpose, and the validator
 * refuses the step (`browse.not_enabled`) until a human turns it on here.
 *
 * The domain list is the second half of that decision. Empty means "anywhere
 * the SSRF guard allows", which is a real choice but rarely the right one for
 * an app that browses on a viewer's behalf.
 */
function AiBrowsingSettings({ value, onCommit, disabled }) {
    const { t } = useTranslation();
    const enabled = value?.enabled === true;
    const domains = Array.isArray(value?.allowedDomains) ? value.allowedDomains : [];
    const [draft, setDraft] = React.useState(domains.join('\n'));
    // Re-sync when the definition changes underneath (undo, another surface).
    React.useEffect(() => { setDraft(domains.join('\n')); }, [domains.join('\n')]);

    const commitDomains = () => {
        const list = draft
            .split(/[\n,]/)
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean);
        onCommit({ allowedDomains: list });
    };

    return (
        <div>
            <SectionTitle>{t('studio_apps_insp.theme.ai_browsing', 'AI browsing')}</SectionTitle>
            <div className="flex flex-col gap-3">
                <Toggle
                    label={t('studio_apps_insp.theme.ai_browsing_toggle', 'Let this app browse the web')}
                    checked={enabled}
                    onChange={(v) => onCommit({ enabled: v })}
                    disabled={disabled}
                    size="sm"
                />
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('studio_apps_insp.theme.ai_browsing_explainer', 'An AI browsing step opens a real browser as you, and viewers watch it work. Only you can switch this on — the app builder cannot. Your organisation can revoke it at any time by turning off the Browse Web integration.')}
                </p>
                {enabled ? (
                    <FormField
                        label={t('studio_apps_insp.theme.sites_label', 'Sites it may open')}
                        hint={t('studio_apps_insp.theme.sites_hint', 'One per line. Subdomains are included. Leave empty to allow any public site — rarely what you want.')}
                    >
                        <textarea
                            className="w-full rounded-lg text-sm p-2 outline-none focus:ring-2"
                            style={{
                                background: 'var(--bg-primary)',
                                border: '1px solid var(--border-default)',
                                color: 'var(--text-primary)',
                                '--tw-ring-color': 'var(--accent-primary)',
                            }}
                            rows={4}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commitDomains}
                            placeholder={'nhs.uk\nwho.int'}
                            disabled={disabled}
                            aria-label={t('studio_apps_insp.theme.sites_label', 'Sites it may open')}
                        />
                    </FormField>
                ) : null}
            </div>
        </div>
    );
}
