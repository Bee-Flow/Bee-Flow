import useTranslation from '@/hooks/useTranslation';
import { SectionTitle } from '../AiBrowsingSettings';
import { SelectField } from '../panels/kit';
import HexColourField from '../panels/HexColourField';
import { THEME_ENUMS } from '../styleKnobMeta';
import { updateScreen } from '../../state/definitionOps';
import type { ThemeSectionEntry, ThemeSectionProps } from '../themeSections';

/**
 * screen.theme (schema 3): the theme of the screen on the canvas where it differs from the app
 * theme. Every field starts at "Same as the app" (the key absent); clearing the last one removes
 * the override. The runtime applies it to the screen only (runtime/themeScope.ts).
 */

const COLOUR_KEYS = ['primary', 'accent', 'canvas'] as const;
const ENUM_KEYS = ['appearance', 'density', 'radius'] as const;

/** The screen's override with `key` set to `value`, or removed for ''. Undefined when nothing is left. */
export function nextScreenTheme(current: unknown, key: string, value: string): Record<string, unknown> | undefined {
    const next: Record<string, unknown> = { ...(current && typeof current === 'object' ? current as Record<string, unknown> : {}) };
    if (value) next[key] = value;
    else delete next[key];
    return Object.keys(next).length ? next : undefined;
}

function ScreenThemeSection({ definition, onCommit, disabled, screenId }: ThemeSectionProps) {
    const { t } = useTranslation();
    const screen = (definition?.screens || []).find((s) => s.id === screenId) || null;
    if (!screen) return null;
    const override = (screen.theme && typeof screen.theme === 'object' ? screen.theme : {}) as Record<string, unknown>;
    const appTheme = (definition.theme || {}) as Record<string, unknown>;
    const commit = (key: string, value: string) => {
        if ((override[key] ?? '') === value) return;
        const def = updateScreen(definition, screen.id, { theme: nextScreenTheme(override, key, value) });
        if (def !== definition) onCommit(def);
    };
    const same = t('studio_apps_lk16.screen.same_as_app', 'Same as the app');
    const labels: Record<string, string> = {
        primary: t('studio_apps_lk16.screen.primary', 'Primary colour'),
        accent: t('studio_apps_lk16.screen.accent', 'Accent colour'),
        canvas: t('studio_apps_lk16.screen.canvas', 'Page ground'),
        appearance: t('studio_apps_lk16.screen.appearance', 'Appearance'),
        density: t('studio_apps_lk16.screen.density', 'Density'),
        radius: t('studio_apps_lk16.screen.radius', 'Corners'),
    };
    return (
        <div data-testid="screen-theme-settings" className="flex flex-col gap-3">
            <SectionTitle>{t('studio_apps_lk16.screen.title', 'Theme of this screen')}</SectionTitle>
            {COLOUR_KEYS.map((key) => (
                <div key={key} className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">{labels[key]}</span>
                    <HexColourField
                        value={typeof override[key] === 'string' ? String(override[key]) : ''}
                        fallback={typeof appTheme[key] === 'string' ? String(appTheme[key]) : '#0F766E'}
                        onPick={(colour) => { if (!disabled) commit(key, colour); }}
                        label={labels[key]}
                    />
                    {override[key] ? (
                        <button type="button" className="self-start text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]" onClick={() => commit(key, '')} disabled={disabled}>
                            {same}
                        </button>
                    ) : null}
                </div>
            ))}
            {ENUM_KEYS.map((key) => (
                <SelectField
                    key={key}
                    label={labels[key]}
                    value={typeof override[key] === 'string' ? String(override[key]) : ''}
                    onChange={(v) => commit(key, v)}
                    options={[{ value: '', label: same }, ...(THEME_ENUMS[key] || []).map((v) => ({ value: v, label: v }))]}
                    disabled={disabled}
                />
            ))}
            <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_lk16.screen.hint', 'Applies to this screen only; the navigation keeps the app theme.')}</p>
        </div>
    );
}

const entry: ThemeSectionEntry = { order: 12, Section: ScreenThemeSection };
export default entry;
