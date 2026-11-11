import useTranslation from '@/hooks/useTranslation';
import ScopeThemeFields, { nextScopeTheme } from '../ScopeThemeFields';
import { updateScreen } from '../../state/definitionOps';
import type { ThemeSectionEntry, ThemeSectionProps } from '../themeSections';

/**
 * screen.theme (schema 3): the theme of the screen on the canvas where it differs from the app
 * theme. Every field starts at "Same as the app" (the key absent); clearing the last one removes
 * the override. The runtime applies it to the screen only (runtime/themeScope.ts). The fields are
 * ScopeThemeFields, shared with the section's theme in SectionInspector.
 */

const COLOUR_KEYS = ['primary', 'accent', 'canvas'] as const;

/** The screen's override with `key` set to `value`, or removed for ''. Undefined when nothing is left. */
export const nextScreenTheme = nextScopeTheme;

function ScreenThemeSection({ definition, onCommit, disabled, screenId }: ThemeSectionProps) {
    const { t } = useTranslation();
    const screen = (definition?.screens || []).find((s) => s.id === screenId) || null;
    if (!screen) return null;
    const override = (screen.theme && typeof screen.theme === 'object' ? screen.theme : {}) as Record<string, unknown>;
    const commit = (key: string, value: string) => {
        const def = updateScreen(definition, screen.id, { theme: nextScopeTheme(override, key, value) });
        if (def !== definition) onCommit(def);
    };
    return (
        <ScopeThemeFields
            override={override}
            inherited={(definition.theme || {}) as Record<string, unknown>}
            colourKeys={COLOUR_KEYS}
            title={t('studio_apps_lk16.screen.title', 'Theme of this screen')}
            hint={t('studio_apps_lk16.screen.hint', 'Applies to this screen only; the navigation keeps the app theme.')}
            testId="screen-theme-settings"
            onSet={commit}
            disabled={disabled}
        />
    );
}

const entry: ThemeSectionEntry = { order: 12, Section: ScreenThemeSection };
export default entry;
