import type { TitleFor } from './nodeLogicSummary';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import type { AppDefinition } from '../inspector/appDefinition';

// Re-exported so logicRows.ts takes all its types from one import: the file is at its line ceiling.
export type { TitleFor } from './nodeLogicSummary';
export type { TranslateFn, TranslateParams } from '../../../../../hooks/useTranslation';
export type { AppAction, AppDefinition, AppNode, AppScreen, CommonNodeProps } from '../inspector/appDefinition';

/** One row of the Logic table: a moment ("when") and what happens then ("what"). */
export interface LogicRow {
    key: string;
    kind: 'event' | 'screen_open' | 'orphan_action' | 'automation';
    wired: boolean;
    screenId: string | null | undefined;
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
    /** `screen_open` rows only: how many components load data, and which tables. */
    loaderCount?: number;
    tableIds?: string[];
}

/** What the caller of `baseRow` supplies; the rest is defaulted. */
export type RowDraft = Partial<Omit<LogicRow, 'key' | 'when' | 'what'>> & { key: string; when: string };

/** The node-side facts every row of one component shares. */
export type RowCommon = Pick<LogicRow, 'screenId' | 'screenName' | 'nodeId' | 'nodeType' | 'path'>;

/** The two ways a row lands in the table: bound to an action, or a dotted empty slot. */
export interface RowEmitter {
    plain: (row: RowDraft) => void;
    wired: (row: RowDraft, actionId: string) => void;
}

/** What `makeEmitter` needs: the rows to append to, and what to name actions with. */
export interface EmitterInputs {
    rows: LogicRow[];
    definition: AppDefinition | null | undefined;
    titleFor: TitleFor | null;
    t: TranslateFn;
    referenced: Set<string>;
}

/** An automation row as the list endpoint returns it, as far as this module reads it. */
export interface AutomationLike {
    id?: string;
    title?: string;
    projectId?: string | null;
    triggerType?: string;
    definition?: {
        trigger?: { kind?: string; filter?: { tableId?: string } };
        steps?: unknown;
    };
}

/** The part of a save notice (or any message) that points at a definition path. */
export interface NoticeLike {
    path?: unknown;
}

/** How well a notice belongs to a row: the tier of the match, and the row path length. */
export interface NoticeScore {
    tier: number;
    len: number;
}

/** Any object, read for the `tableId` a table binding carries. */
export interface TableIdHolder {
    tableId?: unknown;
}

/** Options of `logicRows`. */
export interface LogicRowsOptions {
    titleFor?: TitleFor | null;
    t?: TranslateFn;
}

/** Options of `derivedAutomationRows`. */
export interface DerivedAutomationOptions {
    app?: { projectId?: string | null } | null;
    automationRows?: Record<string, AutomationLike> | null;
    boundTableIds?: Set<string> | string[] | null;
    wiredAutomationIds?: Set<string> | string[] | null;
    t?: TranslateFn;
}
