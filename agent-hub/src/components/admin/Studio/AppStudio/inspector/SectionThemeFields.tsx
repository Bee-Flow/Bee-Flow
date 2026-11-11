import useTranslation from '@/hooks/useTranslation';
import ScopeThemeFields, { nextScopeTheme } from './ScopeThemeFields';
import { updateSection } from '../state/structureOps';
import type { AppDefinition, AppSection } from './appDefinition';

/**
 * section.theme (schema 3) in the section inspector: the same fields as the theme of a screen,
 * without canvas (the page ground belongs to the screen). A colour field shows the theme the
 * section sits in (the app theme under its screen's override) until it is set; clearing the
 * last field removes the key, so a section the author leaves alone keeps its bytes.
 */

const COLOUR_KEYS = ['primary', 'accent'] as const;

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

interface Props {
    definition: AppDefinition;
    section: AppSection;
    onCommit: (definition: AppDefinition) => void;
    disabled: boolean;
}

export default function SectionThemeFields({ definition, section, onCommit, disabled }: Props) {
    const { t } = useTranslation();
    const override = asObject((section as { theme?: unknown }).theme);
    const screen = (definition.screens || []).find((s) => (s.sections || []).some((x) => x.id === section.id));
    const inherited = { ...asObject(definition.theme), ...asObject((screen as { theme?: unknown } | undefined)?.theme) };
    const commit = (key: string, value: string) => {
        const next = updateSection(definition, section.id as string, { theme: nextScopeTheme(override, key, value) });
        if (next !== definition) onCommit(next);
    };
    return (
        <ScopeThemeFields
            override={override}
            inherited={inherited}
            colourKeys={COLOUR_KEYS}
            title=""
            hint={t('studio_apps_w3d.section_theme.hint', 'Applies to this section only; the page ground stays the one of the screen.')}
            testId="section-theme-settings"
            onSet={commit}
            disabled={disabled}
        />
    );
}
