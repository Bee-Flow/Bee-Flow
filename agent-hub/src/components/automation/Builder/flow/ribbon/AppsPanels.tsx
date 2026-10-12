import { isSuite } from '../appsRibbonLayout';
import { categoryGlyphFor } from '../appGlyphs';
import useTranslation from '../../../../../hooks/useTranslation';
import { CategoryPill, appPill } from './AppCommands';
import type { OpenState } from './AppCommands';
import PillRow from './PillRow';
import type { RowPill } from './PillRow';
import { appRow } from './menuRows';
import type { AppCategory, RibbonApp, StepPayload } from './ribbonCategories';

type AddFn = (payload: StepPayload) => void;

interface SuitePanelProps extends OpenState {
    /** The integration category: Nextcloud, Google Workspace or Microsoft 365. */
    category: string;
    apps: RibbonApp[];
    testId: string;
    enabled: boolean;
    onAdd: AddFn;
}

/**
 * A vendor suite's tab (Nextcloud apps, Google Workspace, Microsoft 365):
 * every app of the one suite as a pill (the model the other tabs follow), by
 * its short name, since the tab names the vendor. Too many for the row, and
 * the last ones fold into "More", which then stands in for them as
 * `more:<category>` for the build film.
 */
export function SuitePanel({ category, apps, testId, enabled, onAdd, openKey, setOpenKey }: SuitePanelProps) {
    const { t } = useTranslation();
    const open = { openKey, setOpenKey };
    return (
        <PillRow
            segments={[apps.map(app => appPill(app, { category, foldTitle: category, pooled: false }, { onAdd, t, ...open }))]}
            testId={testId}
            enabled={enabled}
            moreOrigins={[`more:${category}`]}
            moreFilterLabel={(n) => t('automations.ribbon.filter_apps', 'Filter {n} apps…', { n })}
            onAdd={onAdd}
            {...open}
        />
    );
}

interface OtherAppsPanelProps extends OpenState {
    categories: AppCategory[];
    enabled: boolean;
    onAdd: AddFn;
}

/**
 * Every outside app without a tab of its own, on ONE row: each category of
 * three apps or more (flow/appsRibbonLayout.js) as one pill listing its apps,
 * then the loose apps of the smaller categories under their full names. What
 * does not fit folds into "More". Bee Flow's own steps and tools are not
 * here: Call a web service and Code sit on Logic, the tools on the tab of the
 * job they do (NATIVE_APP_HOME).
 */
export function OtherAppsPanel({ categories, enabled, onAdd, openKey, setOpenKey }: OtherAppsPanelProps) {
    const { t } = useTranslation();
    const open = { openKey, setOpenKey };
    const suites = categories.filter(c => isSuite(c) && c.apps.length > 0);
    const loose = categories.filter(c => !isSuite(c)).flatMap(c => c.apps.map(app => ({ app, category: c.category })));
    const looseTitle = suites.length > 0 ? t('automations.ribbon.more_apps', 'More apps') : t('automations.ribbon.apps', 'Apps');

    const suitePills: RowPill[] = suites.map(({ category, apps }) => ({
        key: `cat:${category}`,
        node: <CategoryPill category={category} apps={apps} glyph={categoryGlyphFor(category)} onAdd={onAdd} {...open} />,
        fold: { key: `cat:${category}`, title: category, rows: apps.map(app => appRow(app, t)) },
        origins: [`cat:${category}`],
    }));
    const loosePills = loose.map(({ app, category }) => appPill(app, { category, foldTitle: looseTitle, pooled: true }, { onAdd, t, ...open }));

    return (
        <PillRow
            segments={[suitePills, loosePills]}
            testId="ribbon-other-apps"
            enabled={enabled}
            moreFilterLabel={(n) => t('automations.ribbon.filter_apps', 'Filter {n} apps…', { n })}
            onAdd={onAdd}
            {...open}
        />
    );
}
