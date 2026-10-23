import type { Filed } from '../../components/admin/Studio/Solutions/useAddFiling';
import type React from 'react';
import type { TranslateParams } from '../../hooks/useTranslation';

/**
 * The middle column of "Data & connections": four kinds of cards about what
 * hangs off this page.
 *
 *   TABLE         per bound datatable — rows, column chips, and a dotted
 *                 "not used" if the page does not mention it in its own code.
 *   AUTOMATION    per automation that feeds such a table (from the usage
 *                 index): which columns it touches and when it ran.
 *   KNOWLEDGE     the webpage_auto KB. It already exists and the design does
 *                 not draw it, but it belongs to "what feeds this page" and so
 *                 counts toward the n. It comes from `sources`, which the tab
 *                 already has.
 *   WARNING       an automation that writes DIRECTLY into a bound table.
 *
 * ── THREE THINGS THIS SCREEN MAY NOT CLAIM ──────────────────────────
 *
 * 1. `usedInCode` is THREE-VALUED. `false` means "we looked and did not find
 *    it"; `null` means "the files could not be read". Only the first gets the
 *    dotted "not used" pill. Unknown stays silent.
 *
 * 2. A PUBLIC COLUMN IS MARKED AS SUCH. `publicColumns` is the gate the
 *    snapshot writer on /w/<slug> renders from; whoever sees only "columns"
 *    here does not know which of them leave the building.
 *
 * 3. "Read only" and "Read and write" are two DIFFERENT pills. Public
 *    bindings are read-only by definition, so 'readwrite' here is about logged-in readers.
 */

export interface TableRef {
    datatableId: string;
    missing?: boolean;
    name?: string;
    mode?: string;
    usedInCode?: boolean | null;
    rowCount?: number | null;
    columns?: string[];
    publicColumns?: string[];
    allColumns?: Filed[];
}

export interface AutomationRef {
    automationId: string;
    datatableId: string;
    title?: string;
    writes?: boolean;
    tableName?: string;
    lastRunAt?: string;
    columns: string[];
}

export interface WarningRef {
    kind: string;
    automationId: string;
    automationTitle: string;
    datatableId: string;
    tableName: string;
}

export interface DataCardsPayload {
    tables?: TableRef[];
    automations?: AutomationRef[];
    warnings?: WarningRef[];
}

/**
  * The card and the chip are exported because the column next to it
  * (WebpageActionsPanel) should have the same shape: one tab, one card shape. A
  * second definition would drift apart within a month.
 */
export interface CardProps {
    children?: React.ReactNode;
    tone?: string;
}

export interface ChipProps {
    label: string;
    tone?: string;
    dashed?: boolean;
    title?: string;
}

/** The column chips of one table: bound columns, public ones marked separately. */
export interface ColumnChipsProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    columns: string[];
    publicColumns: string[];
    allColumns: Filed[];
}

export interface TableCardProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    table: TableRef;
}

export interface AutomationCardProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    automation: AutomationRef;
}

export interface WarningCardProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    warning: WarningRef;
    onNavigate?: ((path: string) => void) | null;
}

export interface KnowledgeCardProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    sources: { id: string }[];
}

/**
 * @param {object} props
 * @param {string} props.webpageId
  * @param {Array}  [props.sources]     the sources the Data tab already has
  * @param {function} [props.onNavigate] in-app navigation for the deep links
 */
export interface WebpageDataCardsProps {
    webpageId: string | number | boolean;
    sources?: { id: string }[];
    onNavigate?: ((path: string) => void) | null;
}
