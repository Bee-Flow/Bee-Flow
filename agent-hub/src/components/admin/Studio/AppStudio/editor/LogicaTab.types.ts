import type { TranslateParams } from '@/hooks/useTranslation';
import type { AppDefinition } from '../inspector/appDefinition';
import type { SavePayload, SaveNotice } from './saveNotices';

export type TFn = (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;

/** One line of the table, as far as this tab reads it. */
export interface LogicTableRow {
    key: string;
    kind: string;
    wired: boolean;
    screenId: string | null;
    screenName: string;
    nodeId: string | null;
    nodeType: string | null;
    surfaceLabel: string | null;
    actionKind: string | null;
    automationId: string | null;
    when: string;
    what: string;
}

/** What a row's status column shows. */
export interface RowStatus {
    state: string;
    text?: string;
}

/** Jump from a row to its component on the canvas. */
export type RevealFn = (target: { screenId: string | null; nodeId: string | null }) => void;

export interface LogicaTabProps {
    app: { id: string; projectId: string | null };
    definition: AppDefinition | null;
    onCommit?: (def: AppDefinition) => void;
    onReveal?: RevealFn;
    saveNotices?: SavePayload | null;
    disabled?: boolean;
}

/** One line of the table. Unwired = dotted, never left out. */
export interface LogicRowProps {
    row: LogicTableRow;
    status: RowStatus;
    notices: SaveNotice[];
    onReveal?: RevealFn;
    t: TFn;
}

/**
  * The status column. Three of the four states draw no number, and that is the
  * whole point: "loading" has no answer yet, "none" has no business showing a
  * count, and "unknown" is a read that did NOT succeed. Only "known" puts a
  * number there.
 */
export interface StatusCellProps {
    status: RowStatus;
    t: TFn;
}

/** The header of a group of rows: a screen, or the routines section. */
export interface GroupHeadingProps {
    title: string;
    hint?: string | null;
}

/** When · Happens · Status · ↗, grouped per screen, automations at the bottom. */
export interface LogicTableProps {
    groups: { key: string; name: string; rows: LogicTableRow[] }[];
    automations: LogicTableRow[];
    statusOf: (row: LogicTableRow) => RowStatus;
    noticesByRow: Map<string, SaveNotice[]>;
    onReveal?: RevealFn;
    t: TFn;
}
