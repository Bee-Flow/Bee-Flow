import type { AppNode, CommonNodeProps, AppDefinition } from '../inspector/appDefinition';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AutomationRow } from './automationTitles';

/** All components of one screen, flat, with their definition path attached. */
export interface NodeEntry {
    node: AppNode<CommonNodeProps>;
    path: string;
}

/** The fields every logic row carries from its component or screen. */
export type RowCommon = {
    screenId: string;
    screenName: string;
    nodeId: string | null;
    nodeType: string | null;
    path: string;
};

/** One line of the logic table. */
export interface LogicRow {
    key: string;
    kind: string;
    wired: boolean;
    screenId: string | null;
    screenName: string;
    nodeId: string | null;
    nodeType: string | null;
    event: string | null;
    surface: string | null;
    surfaceLabel: string | null;
    actionId: string | null;
    actionKind: string | null;
    automationId: string | null;
    path: string;
    descriptive: boolean;
    when: string;
    what: string;
    loaderCount?: number;
    tableIds?: string[];
}

export type RowExtra = Partial<LogicRow> & Pick<LogicRow, 'key' | 'when'>;

/**
  * The two ways a row ends up in the table.
  *
  * `wired` records the action behind it AND remembers that something points at
  * that action: the same reached-set that validate.js uses to decide
  * `action.unreachable`. `plain` is the dotted row: a slot that CAN be wired and
  * is not.
 */
export interface MakeEmitterArgs {
    rows: LogicRow[];
    definition: AppDefinition | null;
    titleFor: ((automationId?: string | null) => string | null) | null;
    t: TranslateFn;
    referenced: Set<string>;
}

/**
  * All rows for the table, in reading order.
  *
  * `titleFor(automationId)` names an automation; whoever lacks it gets
  * "Run automation" unadorned, as everywhere else.
 */
export interface LogicRowsOptions {
    titleFor?: ((automationId?: string | null) => string | null) | null;
    t?: TranslateFn;
}

/**
  * "Automations in this app" — automations in the SAME SOLUTION that touch the
  * tables this app is bound to.
  *
  * DEVIATION FROM THE ARTBOARD, deliberate. The artboard shows this as a list
  * that belongs to the app, as if the app had a "my automations" field. That
  * field does not exist and should not exist: a second place that says which
  * automations belong to an app is a second truth that silently drifts out of
  * step as soon as someone renames, moves or deletes the automation. So the list
  * is DERIVED from two things that are already true: `app.projectId` (the
  * solution the app is archived in, studioAppStore.mapAppMetaRow) and the
  * tables the definition binds.
  *
  * Both conditions are needed. "Same solution" alone would list every automation
  * in the folder, including the nightly invoice mail that has nothing to do with
  * this app; "touches the table" alone would pull in colleagues' automations
  * from other solutions. An app WITHOUT a solution (`projectId` null) therefore
  * yields an empty list: "all automations that touch this table" is a different
  * question, and casually putting the answer to it here is exactly the widening
  * this screen must not do.
  *
  * Automations that already hang on a button do NOT come back: they are listed
  * above already, with the button next to them. What remains is the answer to
  * "which of MY automations also run on this data", and that was visible nowhere.
  *
  * THIRD NARROWING, and it is not here but in the source: `automationRows`
  * comes from GET /api/automation → getAutomationsForUser (`WHERE user_id = $1`),
  * so these are the VIEWER's automations. A colleague's nightly automation, in
  * the same solution and on the same table, is not in it. That is acceptable,
  * but then the heading must say so, because an empty section cannot be told
  * apart from "there are none". LogicaTab therefore puts "Your automations
  * in this solution" above it and names the exclusion in the subtitle.
 */
export interface DerivedAutomationRowsArgs {
    app?: { projectId: string | null; id?: string };
    automationRows?: { [x: string]: AutomationRow; } | null;
    boundTableIds?: Set<string> | string[] | null;
    wiredAutomationIds?: Set<string> | string[] | null;
    t?: TranslateFn;
}
