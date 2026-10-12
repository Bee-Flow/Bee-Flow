import { CmdButton, RibbonDropdown, AppGlyph } from './jsComponents';
import type { ReactNode } from 'react';
import { uiDescription } from '../appLabels';
import { stepDragProps } from '../stepDrag';
import useTranslation from '../../../../../hooks/useTranslation';
import { AppActionsList, DropdownPill } from './MenuPanel';
import { actionPayload, appDescription, appRow } from './menuRows';
import type { RowPill } from './PillRow';
import type { RibbonApp, StepPayload } from './ribbonCategories';

/**
 * The app pills of the suite tabs (Nextcloud, Google Workspace, Microsoft
 * 365), the Other apps tab and Bee Flow's own tools on the step tabs. A
 * single-action app adds on click; a multi-action app opens its action list;
 * a suite of apps is one pill whose dropdown lists its apps, each opening its
 * actions. Every one carries its build-film origin stamp (`app:<id>`,
 * `cat:<category>`, flow/ribbonOrigin.js), and every addable one is a drag
 * source.
 */

export const DRAG_HINT_KEY = 'automations.ribbon.drag_hint';
export const DRAG_HINT = 'Click to add, or drag it onto the canvas.';

type AddFn = (payload: StepPayload) => void;
type Translate = (key: string, fallback?: string, params?: Record<string, unknown>) => string;

export interface OpenState {
    openKey: string | null;
    setOpenKey: (next: string | null | ((k: string | null) => string | null)) => void;
}

interface AppCommandProps extends OpenState {
    app: RibbonApp;
    category?: string | null;
    /** Outside its own suite's tab nothing names the vendor, so the full name shows. */
    pooled?: boolean;
    onAdd: AddFn;
}

export function AppCommand({ app, category = null, pooled = false, openKey, setOpenKey, onAdd }: AppCommandProps) {
    const { t } = useTranslation();
    const actions = app.actions || [];
    const desc = appDescription(app, t);
    const label = pooled ? app.label : (app.shortLabel || app.label);
    const tipTitle = pooled && category ? `${app.label} · ${category}` : app.label;
    if (actions.length === 1) {
        // The PAYLOAD keeps the full name: a card on the canvas has no caption to supply the vendor.
        const payload = actionPayload(actions[0], app.label);
        return (
            <CmdButton
                glyph={<AppGlyph integrationId={app.integrationId} size={14} />}
                label={label}
                tipTitle={tipTitle}
                desc={uiDescription(actions[0].description) || desc}
                tipFooter={t(DRAG_HINT_KEY, DRAG_HINT)}
                onClick={() => onAdd(payload)}
                grabbable
                data-ribbon-origin={`app:${app.integrationId}`}
                {...stepDragProps(payload)}
            />
        );
    }
    const key = `app:${app.id}`;
    return (
        <RibbonDropdown
            glyph={<AppGlyph integrationId={app.integrationId} size={16} />}
            label={label}
            tipTitle={tipTitle}
            desc={desc}
            tipFooter={t('automations.ribbon.app_pick_action', '{n} actions. Pick one.', { n: actions.length })}
            width={320}
            open={openKey === key}
            onToggle={() => setOpenKey(k => (k === key ? null : key))}
            buttonProps={{ 'data-ribbon-origin': `app:${app.integrationId}` }}
        >
            <AppActionsList app={app} onAdd={onAdd} />
        </RibbonDropdown>
    );
}

interface CategoryPillProps extends OpenState {
    category: string;
    apps: RibbonApp[];
    glyph: ReactNode;
    onAdd: AddFn;
}

/** A suite (Google Workspace, Microsoft 365, ...) as one pill: its apps, each opening its actions. */
export function CategoryPill({ category, apps, glyph, onAdd, openKey, setOpenKey }: CategoryPillProps) {
    const { t } = useTranslation();
    return (
        <DropdownPill
            id={`cat:${category}`}
            label={category}
            glyph={glyph}
            desc={`${apps.map(a => a.shortLabel || a.label).join(', ')}.`}
            tipFooter={t('automations.ribbon.n_apps_pick', '{n} apps. Pick one.', { n: apps.length })}
            origin={`cat:${category}`}
            title={category}
            sections={[{ key: category, title: category, rows: apps.map(app => appRow(app, t)) }]}
            filterLabel={(n) => t('automations.ribbon.filter_apps', 'Filter {n} apps…', { n })}
            onAdd={onAdd}
            openKey={openKey}
            setOpenKey={setOpenKey}
        />
    );
}

interface PillContext extends OpenState {
    onAdd: AddFn;
    t: Translate;
}

/**
 * An app as a row pill; folded, it is an app row in "More" (opening its
 * actions there). `pooled`: no header names its vendor, so the full name
 * shows. `category` null: the app has no vendor to name in its tip (a Bee
 * Flow tool on the tab of its job).
 */
export function appPill(app: RibbonApp, where: { category: string | null; foldTitle: string; pooled: boolean }, { onAdd, t, ...open }: PillContext): RowPill {
    return {
        key: `app:${app.id}`,
        node: <AppCommand app={app} category={where.category} pooled={where.pooled} onAdd={onAdd} {...open} />,
        fold: { key: `apps:${where.foldTitle}`, title: where.foldTitle, rows: [appRow(app, t, where.pooled)] },
        origins: [`app:${app.integrationId}`],
    };
}

/**
 * Bee Flow's own tools on a step tab (AI, Logic, Data & documents): one pill
 * each, under the tool's full name, folding into "More" under the tab's name.
 */
export function nativeAppPills(apps: RibbonApp[], foldTitle: string, ctx: PillContext): RowPill[] {
    return apps.map(app => appPill(app, { category: null, foldTitle, pooled: true }, ctx));
}
