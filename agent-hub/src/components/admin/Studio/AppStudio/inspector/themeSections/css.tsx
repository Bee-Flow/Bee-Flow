import React, { useCallback, useMemo } from 'react';
import useTranslation from '@/hooks/useTranslation';
import Toggle from '@/components/shared/Toggle';
import CustomCssEditor from '@/components/automation/Builder/flow/settings/formStyle/CustomCssEditor';
import type { CustomCssEditorVariant } from '@/components/automation/Builder/flow/settings/formStyle/CustomCssEditor';
import { removedLabel } from '@/components/automation/Builder/flow/settings/formStyle/removedLabels';
import { SectionTitle } from '../AiBrowsingSettings';
import { useEditorChrome } from '../../editor/EditorChromeContext';
import { APP_CSS_MAX, sanitizeAppCssClient } from '../../runtime/appCss';
import { setAppCssOff, useAppCssOff } from '../../runtime/appCssSwitch';
import { updateDesign } from '../../state/definitionOps';
import type { ThemeSectionEntry, ThemeSectionProps } from '../themeSections';

/**
 * The "Custom CSS" section of the theme panel: the app's own stylesheet
 * (`design.customCss`, server/appStudio/appCss.mts says what is kept).
 *
 * The field is the form builder's CSS field with the app's rules: what the sanitiser takes
 * out is named under it as you type, with the selectors that are a contract as its cheat
 * sheet. "CSS off" shows the canvas and the preview without the stylesheet; it is state of
 * this editor only (runtime/appCssSwitch.ts) and never saved.
 */

type Tr = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** The sanitiser's labels in the app's wording; a CSS token (`@import`) stays as it is. */
const APP_LABELS: Record<string, [string, string]> = {
    'outside address': ['studio_apps_css.removed_outside', 'an address that is not an inline image or an uploaded file of this app'],
    'sibling selector': ['studio_apps_css.removed_sibling', 'a selector that reaches outside the app'],
    'address from var()': ['studio_apps_css.removed_var', 'an image address taken from a variable'],
    [`over ${APP_CSS_MAX} characters`]: ['studio_apps_css.removed_too_long', 'everything: the CSS is over the limit'],
};

function appRemovedLabel(label: string, t: Tr): string {
    const own = APP_LABELS[label];
    return own ? t(own[0], own[1]) : removedLabel(label, t);
}

/** The selectors an author can rely on, with the ids of the screen on the canvas filled in. */
function Contract({ screenId }: { screenId: string | null }) {
    const { t } = useTranslation();
    const rows: Array<[string, string]> = [
        [`[data-app-screen="${screenId || 'scr_…'}"]`, t('studio_apps_css.sel_screen', 'one screen')],
        ['[data-section-id="sec_…"]', t('studio_apps_css.sel_section', 'one section')],
        ['[data-node-id="cmp_…"]', t('studio_apps_css.sel_node', 'one component')],
        ['[data-app-type="button"]', t('studio_apps_css.sel_type', 'every component of a type')],
        ['.u-name', t('studio_apps_css.sel_class', 'components with the CSS class "name" (set under Style)')],
        ['[data-app-dark="true"]', t('studio_apps_css.sel_dark', 'while the app shows dark')],
    ];
    return (
        <dl className="grid grid-cols-1 gap-y-1 text-[10px] leading-snug" data-testid="app-css-contract">
            {rows.map(([selector, meaning]) => (
                <React.Fragment key={selector}>
                    <dt className="font-mono text-[var(--text-primary)] break-all">{selector}</dt>
                    <dd className="text-[var(--text-secondary)] mb-1">{meaning}</dd>
                </React.Fragment>
            ))}
        </dl>
    );
}

function CssSection({ definition, onCommit, disabled, screenId }: ThemeSectionProps) {
    const { t } = useTranslation();
    const appId = useEditorChrome()?.appId;
    const off = useAppCssOff(appId);
    const stored = (definition.design as { customCss?: unknown } | undefined)?.customCss;
    const value = typeof stored === 'string' ? stored : '';

    const commit = useCallback((css: string) => {
        // An empty field removes the key (null is "not set"), so the app is again one without a stylesheet.
        onCommit(updateDesign(definition, { customCss: css ? css : null }));
    }, [definition, onCommit]);

    const variant = useMemo<CustomCssEditorVariant>(() => ({
        sanitize: sanitizeAppCssClient,
        max: APP_CSS_MAX,
        disabled,
        placeholder: '.u-hero { letter-spacing: 0.02em; }',
        label: t('studio_apps_css.label', 'Stylesheet'),
        hint: t('studio_apps_css.hint', 'Applies to this app only. Use it for what the theme and the style settings cannot do.'),
        removedTitle: t('studio_apps_css.removed_title', 'Left out when the app is shown:'),
        labelOf: appRemovedLabel,
        sheetTitle: t('studio_apps_css.sheet_title', 'What you can target'),
        sheet: <Contract screenId={screenId} />,
    }), [disabled, screenId, t]);

    return (
        <div data-testid="app-css-section">
            <SectionTitle>{t('studio_apps_css.title', 'Custom CSS')}</SectionTitle>
            <div className="flex flex-col gap-3">
                <CustomCssEditor value={value} onChange={commit} variant={variant} />
                <p className="text-[10px] text-[var(--text-tertiary)]">{t('studio_apps_css.high_contrast', 'Not applied under the high-contrast theme.')}</p>
                <Toggle
                    checked={off}
                    onChange={(next) => setAppCssOff(appId, next)}
                    label={t('studio_apps_css.off_label', 'CSS off')}
                    description={t('studio_apps_css.off_hint', 'Shows the app without this stylesheet, in this editor only. Nothing is saved.')}
                    size="sm"
                />
            </div>
        </div>
    );
}

const entry: ThemeSectionEntry = { order: 200, Section: CssSection };

export default entry;
