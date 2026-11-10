import { useState } from 'react';
import ColorPicker from '@/components/shared/ColorPicker';
import FormField from '@/components/shared/FormField';
import Toggle from '@/components/shared/Toggle';
import type { TranslateFn } from '@/hooks/useTranslation';
import AssetRefField from '../../inspector/assets/AssetRefField';
import { INPUT_CLS, SelectField } from '../../inspector/panels/kit';
import { designFields, fontLabels, options, themeFields } from '../../inspector/ThemePanel.helpers';
import { THEME_ENUMS } from '../../inspector/styleKnobMeta';
import type { AppScreen } from '../../inspector/appDefinition';
import { DESIGN_ENUMS } from '../../runtime/appDesign';
import { APP_COLOR_PRESETS } from '../../runtime/themeVars';
import {
    MAX_PUBLIC_SCREENS, MAX_PUBLIC_TITLE, setEntryScreen, setLookKnob, setTitle, toggleScreen,
} from './publicPageModel';
import type { LookPart, PublicAccess } from './publicPageModel';

/**
 * The settings of the public page: which screens, where a visitor lands, the
 * browser title, and the page's own look. Every change is one commit of the
 * whole block (`onChange`), so undo takes back one change at a time.
 */

interface SettingsProps {
    t: TranslateFn;
    pa: PublicAccess;
    screens: AppScreen[];
    disabled: boolean;
    onChange: (next: PublicAccess) => void;
}

export function ScreenPicker({ t, pa, screens, disabled, onChange }: SettingsProps) {
    const full = pa.screenIds.length >= MAX_PUBLIC_SCREENS;
    return (
        <fieldset className="space-y-1.5" data-testid="public-page-screens">
            <legend className="text-xs font-medium text-[var(--text-secondary)]">
                {t('studio_apps_public.screens.legend', 'Screens a visitor may open ({count} of at most {max})', { count: pa.screenIds.length, max: MAX_PUBLIC_SCREENS })}
            </legend>
            <ul className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
                {screens.map((s) => {
                    const checked = pa.screenIds.includes(s.id);
                    const entry = s.id === pa.entryScreenId;
                    return (
                        <li key={s.id}>
                            <label className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]">
                                <input
                                    type="checkbox"
                                    className="h-4 w-4 shrink-0 accent-[var(--accent-primary)]"
                                    checked={checked}
                                    disabled={disabled || entry || (!checked && full)}
                                    onChange={() => onChange(toggleScreen(pa, s.id))}
                                />
                                <span className="truncate">{s.name || s.id}</span>
                                {entry ? <span className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_public.screens.entry_badge', 'entry screen')}</span> : null}
                            </label>
                        </li>
                    );
                })}
            </ul>
            {full ? <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_public.screens.full', 'A public page holds at most {max} screens: a short flow, not a whole app.', { max: MAX_PUBLIC_SCREENS })}</p> : null}
        </fieldset>
    );
}

export function EntryAndTitle({ t, pa, screens, disabled, onChange }: SettingsProps) {
    const listed = screens.filter((s) => pa.screenIds.includes(s.id));
    // Typed text is local until blur/Enter (a commit trims, and trimming per
    // keystroke would eat every space); an outside change (undo) resets it.
    const [title, setTitleText] = useState(pa.title || '');
    const [seen, setSeen] = useState(pa.title || '');
    if ((pa.title || '') !== seen) {
        setSeen(pa.title || '');
        setTitleText(pa.title || '');
    }
    const commitTitle = () => { if ((pa.title || '') !== title.trim()) onChange(setTitle(pa, title)); };
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
                label={t('studio_apps_public.entry.label', 'Entry screen')}
                hint={t('studio_apps_public.entry.hint', 'Where a visitor lands when they open the link.')}
                value={pa.entryScreenId}
                onChange={(id) => onChange(setEntryScreen(pa, id))}
                options={listed.map((s) => ({ value: s.id, label: s.name || s.id }))}
                disabled={disabled}
            />
            <FormField label={t('studio_apps_public.title.label', 'Page title')} hint={t('studio_apps_public.title.hint', 'Shown in the browser tab. Empty uses the app name.')}>
                <input
                    type="text"
                    className={INPUT_CLS}
                    value={title}
                    maxLength={MAX_PUBLIC_TITLE}
                    onChange={(e) => setTitleText(e.target.value)}
                    onBlur={commitTitle}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitTitle(); }}
                    disabled={disabled}
                    aria-label={t('studio_apps_public.title.label', 'Page title')}
                />
            </FormField>
        </div>
    );
}

/** One enum knob of the override: "Same as the app" or a value of its own. */
function LookSelect({ t, label, value, values, valueLabels, onPick, disabled }: { t: TranslateFn; label: string; value: string | undefined; values: string[]; valueLabels: Array<{ value: string; label: string }>; onPick: (v: string | null) => void; disabled: boolean }) {
    const labelOf = (v: string) => valueLabels.find((o) => o.value === v)?.label || v;
    return (
        <SelectField
            label={label}
            value={value ?? ''}
            onChange={(v) => onPick(v || null)}
            options={[{ value: '', label: t('studio_apps_public.look.same_as_app', 'Same as the app') }, ...values.map((v) => ({ value: v, label: labelOf(v) }))]}
            disabled={disabled}
        />
    );
}

/** One colour knob of the override: off is the app's colour, on is a colour of its own. */
function LookColor({ t, label, value, onPick, disabled }: { t: TranslateFn; label: string; value: string | undefined; onPick: (v: string | null) => void; disabled: boolean }) {
    return (
        <FormField label={label}>
            <div className="flex flex-col gap-2">
                <Toggle
                    checked={!!value}
                    onChange={(on) => onPick(on ? APP_COLOR_PRESETS[0] : null)}
                    disabled={disabled}
                    size="sm"
                    ariaLabel={t('studio_apps_public.look.own_colour_aria', '{label}: use a colour of its own', { label })}
                />
                {value ? <ColorPicker value={value} onChange={onPick} presets={APP_COLOR_PRESETS} allowCustom disabled={disabled} swatchSize={22} ariaLabel={label} /> : null}
            </div>
        </FormField>
    );
}

const edgeLabels = (t: TranslateFn) => [
    { value: 'bar', label: t('studio_apps_public.look.edge_bar', 'Coloured edge') },
    { value: 'none', label: t('studio_apps_public.look.edge_none', 'No edge') },
];

/**
 * The page's own look, merged over the app's on the public page only. The
 * fields and their labels are the theme panel's own (ThemePanel.helpers); a
 * knob left on "Same as the app" is not written. The logo is the page's own
 * (publicAccess.design.logoUrl, an https URL or an uploaded file): the public
 * page header draws that one only, never the app's.
 */
export function LookOverride({ t, pa, disabled, onChange, appId, definition }: Omit<SettingsProps, 'screens'> & { appId: string; definition: unknown }) {
    const pick = (part: LookPart, key: string) => (v: string | null) => onChange(setLookKnob(pa, part, key, v));
    const theme = pa.theme || {};
    const design = pa.design || {};
    const colors: Array<[string, string]> = [
        ['primary', t('studio_apps_insp.theme.primary_color', 'Primary color')],
        ['accent', t('studio_apps_insp.theme.button_colour', 'Button colour')],
        ['canvas', t('studio_apps_insp.theme.page_background', 'Page background')],
    ];
    const fonts = fontLabels(t);
    return (
        <div className="space-y-3" data-testid="public-page-look">
            <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_public.look.intro', 'Give the public page a look of its own. Anything left on “Same as the app” follows the app; the app’s own screens never change.')}</p>
            <div className="grid gap-3 sm:grid-cols-3">
                {colors.map(([key, label]) => <LookColor key={key} t={t} label={label} value={theme[key]} onPick={pick('theme', key)} disabled={disabled} />)}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
                {themeFields(t).map(({ key, label }) => (
                    <LookSelect key={key} t={t} label={label} value={theme[key]} values={THEME_ENUMS[key]} valueLabels={options(t, THEME_ENUMS[key])} onPick={pick('theme', key)} disabled={disabled} />
                ))}
                <LookSelect t={t} label={t('studio_apps_insp.theme.typeface', 'Typeface')} value={design.font} values={DESIGN_ENUMS.font} valueLabels={DESIGN_ENUMS.font.map((v) => ({ value: v, label: fonts[v] || v }))} onPick={pick('design', 'font')} disabled={disabled} />
                {designFields(t).map(({ key, label }) => (
                    <LookSelect key={key} t={t} label={label} value={design[key]} values={DESIGN_ENUMS[key]} valueLabels={options(t, DESIGN_ENUMS[key])} onPick={pick('design', key)} disabled={disabled} />
                ))}
                <LookSelect t={t} label={t('studio_apps_public.look.edge', 'Callout edge')} value={design.accentEdge} values={DESIGN_ENUMS.accentEdge} valueLabels={edgeLabels(t)} onPick={pick('design', 'accentEdge')} disabled={disabled} />
            </div>
            <AssetRefField
                label={t('studio_apps_public.look.logo', 'Logo of the page')}
                hint={t('studio_apps_public.look.logo_hint', 'Shown at the top of the public page. Empty shows no logo: the app’s own logo is not used here.')}
                value={design.logoUrl ?? null}
                onChange={pick('design', 'logoUrl')}
                appId={appId}
                definition={definition}
                placeholder={t('studio_apps_insp.theme.url_placeholder', 'https://…')}
                disabled={disabled}
            />
        </div>
    );
}
