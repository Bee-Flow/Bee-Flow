import type { DtTable } from './rowBrowser/rowBrowserModel';
import type { MirrorSource, MirrorSync } from './sourceMirrors';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { SourceMirror } from './useSourceMirror';

/** The datatable as the detail view reads it. */
export interface DetailTable extends DtTable {
    name: string;
    key: string;
    description?: string | null;
    scopeKind?: string;
    source?: MirrorSource | null;
    sync?: MirrorSync | null;
}

/** What the health check answers. */
export interface TableHealth {
    healthy?: boolean;
    tableExists?: boolean;
    missingColumns?: string[];
}

/**
 * One table: its columns, its rows, what it holds and for how long, who it is
 * shared with, and — the tab that earns its place — what depends on it.
 *
 * "Used by" is not a nicety. Every other tab here can break something that is
 * not open in front of you: removing a column, tightening sharing, deleting
 * the table. This is the only surface that can answer "what would that break",
 * so the destructive actions read it before they ask.
 *
 * ── ONE USAGE FETCH, NOT THREE ──────────────────────────────────────
 * The column designer, the Used-by tab and the delete confirmation all need the
 * same list, and each used to fetch it for itself — three requests on every
 * open, three chances for them to disagree about what depends on this table
 * while somebody is deciding whether to drop a column. It is fetched once here
 * and handed down.
 *
 * ── THE TABS SIT IN THE COMMAND BAR (Ronde 2, 2026-09-14) ───────────
 * The owner's second design round puts the five tabs inside the 48px bar,
 * "like the editor" — StudioSectionHeader's segment strip, the same strip
 * Knowledge, Skills and Solutions already use. The first build kept them on
 * `shared/Tabs` below the bar for the tablist semantics; the design handoff
 * (Datatables.dc.html 2a–2c) overrides that, and consistency with the other
 * sections wins. Content sits in a 960px column in the middle of the main
 * area; the Rows tab alone runs edge to edge (2b). "Delete this table" is an
 * item in the ⋯ menu, not a red line under every tab (2c).
 */
export interface DatatableDetailProps {
    table: DetailTable;
    canManage: boolean;
    currentUserId?: string | null;
    onNavigate?: ((path: string) => void) | null;
    onBack: () => void;
    onChanged: () => Promise<void>;
    onDeleted: () => void;
    initialTab?: string | null;
}

/**
 * The datatables usage row → UsedByTab's contract.
 *
 * The index went generic (T3): a row now carries `consumerKind`
 * ('automation' | 'app' | 'webpage'), `stepOrdinal`, `stepType`/`stepOp`,
 * `mode` (which may now be 'readwrite') and `lastRunAt`. The legacy
 * `automation*` aliases are still populated for every kind, so they stay the
 * fallback rather than the source.
 */
/** A usage row as the datatables endpoint answers it: the generic fields, with the legacy `automation*` aliases. */
export interface DatatableUsageRow {
    consumerKind?: string;
    consumerId?: string;
    automationId?: string;
    stepOrdinal?: number | string;
    stepOp?: string;
    stepType?: string;
    columns?: (string | null | undefined)[];
    consumerTitle?: string | null;
    automationTitle?: string | null;
    mode?: string;
    lastRunAt?: string | null;
    consumerOwner?: string | null;
    automationOwner?: string | null;
}

/**
 * The ⋯ menu: what belongs to the TABLE rather than to a tab (2c's menu —
 * Rename table · Duplicate · Export CSV · ─ · Delete this table…), plus the
 * items the first round put here that still have no other home.
 *
 * "Technical name" stays because the key is what a Datatable step refers to
 * and it used to be shown once, in the create dialog, and never again — the
 * one place a person goes to look a table up could not tell them the
 * identifier they need. It is a copy button, not a chip, so the header stays
 * the artboard's row and the key is still one click from any tab.
 *
 * "Duplicate" copies the SHAPE — name, purpose, columns — never the rows: a
 * second copy of a table's data is a second thing to keep in step, and the
 * person who wants the rows has Export. A managed table (a cache, a mirror,
 * a form's answers) has no shape of its own to copy, so it has no item.
 */
export interface TableMenuProps {
    t: TranslateFn;
    table: DetailTable;
    canEdit: boolean;
    mirror?: SourceMirror | null;
    isMirror?: boolean;
    onRename?: (() => void) | null;
    onDuplicate?: (() => Promise<void>) | null;
    onDelete?: (() => void) | null;
}

/**
 * Does the physical table still match the model, and put it right if not.
 *
 * Worth a control rather than a support procedure because the repair is
 * add-only by construction — the server diffs this table against ITSELF with
 * no fields, so the plan can only ever be CREATE TABLE and ADD COLUMN, never
 * a drop. Saying that out loud is what makes the button safe to press.
 */
export interface HealthDialogProps {
    t: TranslateFn;
    table: DetailTable;
    onClose: () => void;
}
