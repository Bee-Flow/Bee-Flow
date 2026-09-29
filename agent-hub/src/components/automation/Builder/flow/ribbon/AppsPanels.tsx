import { isSuite } from '../appsRibbonLayout';
import { categoryGlyphFor } from '../appGlyphs';
import useTranslation from '../../../../../hooks/useTranslation';
import { AppCommand, CategoryPill } from './AppCommands';
import type { OpenState } from './AppCommands';
import { ItemPill } from './CommandsPanel';
import PillRow from './PillRow';
import type { RowPill } from './PillRow';
import { appRow, itemRow } from './menuRows';
import type { AppCategory, PaletteItem, RibbonApp, StepPayload } from './ribbonCategories';
import { NEXTCLOUD_CATEGORY } from './ribbonCategories';

type AddFn = (payload: StepPayload) => void;
type Translate = (key: string, fallback?: string, params?: Record<string, unknown>) => string;

interface PillContext extends OpenState {
    onAdd: AddFn;
    t: Translate;
}

/**
 * An app as a row pill; folded, it is an app row in "More" (opening its
 * actions there). `pooled`: no header names its vendor, so the full name shows.
 */
function appPill(app: RibbonApp, where: { category: string; foldTitle: string; pooled: boolean }, { onAdd, t, ...open }: PillContext): RowPill {
    return {
        key: `app:${app.id}`,
        node: <AppCommand app={app} category={where.category} pooled={where.pooled} onAdd={onAdd} {...open} />,
        fold: { key: `apps:${where.foldTitle}`, title: where.foldTitle, rows: [appRow(app, t, where.pooled)] },
        origins: [`app:${app.integrationId}`],
    };
}

interface NextcloudPanelProps extends OpenState {
    apps: RibbonApp[];
    enabled: boolean;
    onAdd: AddFn;
}

/**
 * Nextcloud apps: every app of the one suite as a pill (the model the other
 * tabs follow). Too many for the row, and the last ones fold into "More",
 * which then stands in for them as `more:Nextcloud` for the build film.
 */
export function NextcloudPanel({ apps, enabled, onAdd, openKey, setOpenKey }: NextcloudPanelProps) {
    const { t } = useTranslation();
    const open = { openKey, setOpenKey };
    return (
        <PillRow
            segments={[apps.map(app => appPill(app, { category: NEXTCLOUD_CATEGORY, foldTitle: NEXTCLOUD_CATEGORY, pooled: false }, { onAdd, t, ...open }))]}
            testId="ribbon-nextcloud"
            enabled={enabled}
            moreOrigins={[`more:${NEXTCLOUD_CATEGORY}`]}
            moreFilterLabel={(n) => t('routines.ribbon.filter_apps', 'Filter {n} apps…', { n })}
            onAdd={onAdd}
            {...open}
        />
    );
}

interface OtherAppsPanelProps extends OpenState {
    categories: AppCategory[];
    webAndCode: PaletteItem[];
    enabled: boolean;
    onAdd: AddFn;
}

/**
 * Every other app, on ONE row: HTTP request and Code first (the way out to
 * anything without an app), then each suite (three apps or more,
 * flow/appsRibbonLayout.js) as one pill listing its apps, then the loose apps
 * of the smaller categories under their full names. What does not fit folds
 * into "More".
 */
export function OtherAppsPanel({ categories, webAndCode, enabled, onAdd, openKey, setOpenKey }: OtherAppsPanelProps) {
    const { t } = useTranslation();
    const open = { openKey, setOpenKey };
    const webTitle = t('routines.ribbon.web_and_code', 'Web & code');
    const suites = categories.filter(c => isSuite(c) && c.apps.length > 0);
    const loose = categories.filter(c => !isSuite(c)).flatMap(c => c.apps.map(app => ({ app, category: c.category })));
    const looseTitle = suites.length > 0 ? t('routines.ribbon.more_apps', 'More apps') : t('routines.ribbon.apps', 'Apps');

    const web: RowPill[] = webAndCode.map(item => ({
        key: item.id,
        node: <ItemPill item={item} onAdd={onAdd} />,
        fold: { key: 'web', title: webTitle, rows: [itemRow(item)] },
    }));
    const suitePills: RowPill[] = suites.map(({ category, apps }) => ({
        key: `cat:${category}`,
        node: <CategoryPill category={category} apps={apps} glyph={categoryGlyphFor(category)} onAdd={onAdd} {...open} />,
        fold: { key: `cat:${category}`, title: category, rows: apps.map(app => appRow(app, t)) },
        origins: [`cat:${category}`],
    }));
    const loosePills = loose.map(({ app, category }) => appPill(app, { category, foldTitle: looseTitle, pooled: true }, { onAdd, t, ...open }));

    return (
        <PillRow
            segments={[web, suitePills, loosePills]}
            testId="ribbon-other-apps"
            enabled={enabled}
            moreFilterLabel={(n) => t('routines.ribbon.filter_apps', 'Filter {n} apps…', { n })}
            onAdd={onAdd}
            {...open}
        />
    );
}
