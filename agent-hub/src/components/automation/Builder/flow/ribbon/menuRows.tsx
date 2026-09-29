import type { ReactNode } from 'react';
import { Bot, Layers, Zap } from 'lucide-react';
import { actionLabelMap, uiDescription } from '../appLabels';
import { typeGroupOf } from '../nodeTypeColors';
import { getIntegrationById } from '../../../../../config/integrationCatalog';
import { AppGlyph, IntegrationLogo } from './jsComponents';
import { FAMILY_TEXT } from './ribbonCategories';
import type { IconType, PaletteItem, RibbonApp, StepPayload } from './ribbonCategories';
import type { RibbonResult } from './ribbonSearch';

/**
 * One row of a ribbon dropdown (flow/ribbon/MenuPanel.tsx), whatever it
 * holds: a palette step, an agent or skill, an app action, or an app. A row
 * with a payload adds on click and drags onto the canvas; a row with an `app`
 * of several actions opens that app's action list instead.
 */
export interface RowSpec {
    key: string;
    label: string;
    desc?: string | null;
    glyph: ReactNode;
    payload?: StepPayload | null;
    app?: RibbonApp | null;
    disabled?: boolean;
    disabledReason?: string | null;
    /** More words the dropdown's filter matches (palette keywords, action names). */
    terms?: string;
}

/** A titled run of rows: one dropdown's content, or one folded pill's share of "More". */
export interface MenuSection {
    key: string;
    title: string;
    rows: RowSpec[];
}

type Translate = (key: string, fallback?: string, params?: Record<string, unknown>) => string;
type Action = RibbonApp['actions'][number];

/** A step icon in its node family's colour, the way the canvas card shows it. */
export function FamilyIcon({ Icon, kind, size = 14 }: { Icon: IconType; kind: string; size?: number }) {
    const family = typeGroupOf(kind) as string | null;
    return <Icon size={size} className={(family && FAMILY_TEXT[family]) || 'text-[var(--text-secondary)]'} />;
}

export function itemRow(item: PaletteItem): RowSpec {
    return {
        key: item.id,
        label: item.label,
        desc: item.desc || null,
        glyph: <FamilyIcon Icon={item.icon || Layers} kind={item.payload.kind} />,
        payload: item.payload,
        disabled: !!item.disabled,
        disabledReason: item.disabledReason || null,
        terms: item.keywords,
    };
}

/** An agent or a skill, tinted in its own colour; an agent that cannot be used keeps its reason. */
export function resultRow(r: RibbonResult): RowSpec {
    return {
        key: r.key,
        label: r.label,
        desc: r.secondary || null,
        glyph: r.tone === 'skill'
            ? <Zap size={14} className="text-[var(--kind-skill)]" />
            : <Bot size={14} className="text-[var(--type-ai)]" />,
        payload: r.payload,
        disabled: !!r.disabled,
        disabledReason: r.disabledReason || null,
    };
}

export const actionPayload = (a: Action, label: string): StepPayload => ({
    kind: 'integration_action', tool: a.tool, label, appId: a.integrationId, sideEffect: a.sideEffect,
});

/** An app's actions under their plain names, with what each does. */
export function actionRows(app: RibbonApp): RowSpec[] {
    const actions = app.actions || [];
    const labels = actionLabelMap(actions) as Map<string, string>;
    return actions.map(a => ({
        key: a.tool,
        label: labels.get(a.tool) || a.label,
        desc: (uiDescription(a.description) as string) || null,
        glyph: <IntegrationLogo integrationId={a.integrationId} tool={a.tool} size={14} />,
        // The payload keeps the catalog's full name: the card on the canvas has no header naming the app.
        payload: actionPayload(a, a.label),
        terms: a.tool,
    }));
}

/** What an app is for: the integration catalog's sentence, else "Actions from X." */
export function appDescription(app: RibbonApp, t: Translate): string {
    const known = (getIntegrationById(app.integrationId) || getIntegrationById(app.id)) as { description?: string } | null;
    return known?.description || t('routines.ribbon.app_actions_from', 'Actions from {app}.', { app: app.label });
}

/**
 * An app as a dropdown row. A one-action app adds that action; any other app
 * opens its action list. `fullName` when no header above it names the vendor.
 */
export function appRow(app: RibbonApp, t: Translate, fullName = false): RowSpec {
    const actions = app.actions || [];
    const single = actions.length === 1 ? actions[0] : null;
    return {
        key: app.id,
        label: fullName ? app.label : (app.shortLabel || app.label),
        desc: (single && (uiDescription(single.description) as string)) || appDescription(app, t),
        glyph: <AppGlyph integrationId={app.integrationId} size={14} />,
        payload: single ? actionPayload(single, app.label) : null,
        app: single ? null : app,
        terms: `${app.label} ${actions.map(a => a.label).join(' ')}`,
    };
}
