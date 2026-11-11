import useTranslation from '@/hooks/useTranslation';
import { SectionTitle } from './AiBrowsingSettings';
import { SelectField } from './panels/kit';
import HexColourField from './panels/HexColourField';
import { THEME_ENUMS } from './styleKnobMeta';

/**
 * The fields of a partial theme over a scope (schema 3): screen.theme (themeSections/
 * screenTheme.tsx) and section.theme (SectionInspector). Every field starts at "Same as the app"
 * (the key absent); `onSet(key, '')` clears one. A section takes every key but canvas, so the
 * caller names the colour keys it offers.
 */

const ENUM_KEYS = ['appearance', 'density', 'radius'] as const;

/** The override with `key` set to `value`, or removed for ''. Undefined when nothing is left. */
export function nextScopeTheme(current: unknown, key: string, value: string): Record<string, unknown> | undefined {
    const next: Record<string, unknown> = { ...(current && typeof current === 'object' ? current as Record<string, unknown> : {}) };
    if (value) next[key] = value;
    else delete next[key];
    return Object.keys(next).length ? next : undefined;
}

interface Props {
    /** The scope's own override (the stored theme object, or empty). */
    override: Record<string, unknown>;
    /** The theme the scope sits in: the fallback a colour field shows. */
    inherited: Record<string, unknown>;
    colourKeys: readonly string[];
    title: string;
    hint: string;
    testId: string;
    onSet: (key: string, value: string) => void;
    disabled: boolean;
}

export default function ScopeThemeFields({ override, inherited, colourKeys, title, hint, testId, onSet, disabled }: Props) {
    const { t } = useTranslation();
    const same = t('studio_apps_lk16.screen.same_as_app', 'Same as the app');
    const labels: Record<string, string> = {
        primary: t('studio_apps_lk16.screen.primary', 'Primary colour'),
        accent: t('studio_apps_lk16.screen.accent', 'Accent colour'),
        canvas: t('studio_apps_lk16.screen.canvas', 'Page ground'),
        appearance: t('studio_apps_lk16.screen.appearance', 'Appearance'),
        density: t('studio_apps_lk16.screen.density', 'Density'),
        radius: t('studio_apps_lk16.screen.radius', 'Corners'),
    };
    const set = (key: string, value: string) => { if (!disabled && (override[key] ?? '') !== value) onSet(key, value); };
    return (
        <div data-testid={testId} className="flex flex-col gap-3">
            {title ? <SectionTitle>{title}</SectionTitle> : null}
            {colourKeys.map((key) => (
                <div key={key} className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">{labels[key]}</span>
                    <HexColourField
                        value={typeof override[key] === 'string' ? String(override[key]) : ''}
                        fallback={typeof inherited[key] === 'string' ? String(inherited[key]) : '#0F766E'}
                        onPick={(colour) => set(key, colour)}
                        label={labels[key]}
                    />
                    {override[key] ? (
                        <button type="button" className="self-start text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]" onClick={() => set(key, '')} disabled={disabled}>
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
                    onChange={(v) => set(key, v)}
                    options={[{ value: '', label: same }, ...(THEME_ENUMS[key] || []).map((v) => ({ value: v, label: v }))]}
                    disabled={disabled}
                />
            ))}
            <p className="text-xs text-[var(--text-muted)]">{hint}</p>
        </div>
    );
}
