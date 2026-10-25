import { type LucideIcon } from 'lucide-react';
import { type PermissionUser } from '../../../../hooks/usePermissionCheck';
import type { TableColumn } from '../AppStudio/inspector/aiFieldMatching';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { ConnectionOption } from '../Solutions/pipeline/settings/stageSettingsApi';

/**
 * Create a table (Datatables artboard 1c).
 *
 * The description field is not bureaucracy: the server REFUSES a table with no
 * description, because that sentence is the Art. 30 processing purpose. Asking
 * for it at creation costs one line; reconstructing it a year later, for a
 * table nobody remembers making, costs an afternoon per table. The label says
 * so plainly rather than dressing it up as "optional context".
 *
 * ── THE TECHNICAL NAME MOVED, IT DID NOT GO ─────────────────────────
 * The key is what the physical column family is named, and renaming it later
 * is a migration — so it is still derived from the name, still editable, and
 * still SHOWN: the footer states it in as many words ("Technical name:
 * `customers`"), and the editor for it lives one click away under "All
 * options". A person who names two tables "Customers" still sees why the
 * second one is `customers_2`; what they no longer have to do is walk past a
 * field they will never touch on the way to the one that matters.
 *
 * ── WHERE IT GOES IS A CHOICE, NOT A CONSEQUENCE ────────────────────
 * An account in an organisation can make either kind, and the difference is
 * who else can ever see the rows — so it is two cards with a sentence each,
 * defaulted to what the server would have picked anyway. An account with
 * no organisation is shown the personal option alone rather than a control with
 * one dead half.
 *
 * ── AND THE ORGANISATION HALF IS ONLY OFFERED WHERE IT WORKS ────────
 * Being IN an organisation is not the same as being allowed to put a table in
 * it. POST /api/datatables gates the organisation scope on `manage_datatables`
 * and nothing else (routes/datatables/tables.js: "the org-scope gate, and only
 * here"), so for a plain member the dialog used to offer that card, PRESELECT
 * it, and hand its 403 back as an error under the Create button. That is
 * BFSF-412's shape a third time — the copy promising what the request cannot
 * deliver — except worse, because here the refusal was knowable before the
 * click: the session already carries its permissions.
 *
 * So the card is not shown to an account that cannot use it, and the personal
 * sentence says WHY the other half is missing instead of leaving a silent gap.
 * What is NOT done is narrowing on an absence: a caller that hands the dialog
 * no permissions at all (an embed, a test, an older call site) knows nothing
 * about this session, and reading that as "no" would take the organisation
 * away from the org admin this dialog exists for. Unknown keeps the choice and
 * lets the server have the last word, exactly as before.
 *
 * ── THE FIRST COLUMNS ARE OFFERED HERE ──────────────────────────────
 * `POST /` already accepts `fields`, and without this the shortest path to a
 * usable table was dialog → Columns tab → Save → Rows tab. Left empty it still
 * sends `fields: []`, so the plain path is unchanged.
 *
 * ── AND ONE KIND OF TABLE THE PLATFORM FILLS IN ITSELF ──────────────
 * "Web service answers" provisions a MANAGED table (POST /managed) whose
 * columns are a contract with the http_request step's cache. Its own option
 * rather than a checkbox because everything downstream differs: the columns are
 * not the author's, the description has a server-side default, and the answer
 * carries a warning that has to be read before the table exists to be filled.
 *
 * ── AND ONE KIND THAT COMES FROM NEXTCLOUD ──────────────────────────
 * "A table from Nextcloud" (managedKind `nextcloud_table`) is a copy of a
 * Nextcloud Tables table or view kept in step with it. The card shows for
 * every account whose organisation is bound to Nextcloud — no feature flag —
 * and stays VISIBLE-BUT-DISABLED, with the server's reason, when the Tables
 * integration is off or Nextcloud cannot be reached: this dialog is routinely
 * opened INSIDE Nextcloud, where a hidden option is a support ticket. Choosing it replaces Name/Purpose/Columns (they are per table, in
 * the next step) and hands over to LinkNextcloudTablesDialog.
 *
 * ── AND ONE THAT COMES FROM A SPREADSHEET FILE ──────────────────────
 * "A spreadsheet from your files" (managedKind `spreadsheet_file`) is a
 * copy of one worksheet in Google Drive, OneDrive or Nextcloud Files. The
 * client has NO reliable fact about which storages this account has
 * connected (the session names one login provider; the vault is not in
 * /auth/me), so the card is gated by ONE cheap server probe on open:
 * hidden while the answer is pending or empty, visible-but-disabled with
 * the reason when every storage listed is off. The probe sits in a
 * try/catch on purpose — a failed probe, or a test double without the
 * method, is "no card", never a broken dialog. Chosen, it behaves as the
 * Nextcloud card does and hands over to LinkSpreadsheetDialog.
 *
 * COPY: "this account", never "you". On a self-hosted install the built-in
 * `admin` login is routinely shared between several human operators, so "only
 * you can see it" would be a promise the product cannot keep.
 */
export interface NewDatatableDialogProps {
    scope?: ConnectionOption | null;
    onClose: () => void;
    onCreated: (table: { id: string }) => void;
    user?: PermissionUser | null;
}

/** A wizard's answer: the tables it made and the warnings to read. */
export interface LinkedBody {
    datatables: Array<{ id: string }>;
    warnings?: string[];
}

/** A wizard's answer, tagged with its kind. */
export interface LinkedResult extends LinkedBody {
    kind: 'nextcloud_table' | 'spreadsheet_file';
}

/** A managed table's answer. */
export interface CreatedResult {
    datatable: { id: string };
    warning?: string;
}

/** The 28px kind tile beside the dialog's own name — the section header's own recipe. */
export interface TitleRowProps {
    kind: string;
    text: string;
    icon?: LucideIcon | null;
}

/**
 * The first column or two, so a new table is usable without a second trip.
 *
 * Deliberately thin — name and type only. The Columns tab is where options,
 * reordering and the destructive-change guard live, and duplicating any of
 * that here would mean two places that can disagree about what a column is.
 */
export interface FirstColumnsProps {
    t: TranslateFn;
    fields: TableColumn[];
    problems: string[];
    onChange: (fields: TableColumn[]) => void;
}

/**
 * The type picker: the mapping panel's own glyph and word over a real
 * <select>.
 *
 * A native select, not a menu, because it is the control every keyboard and
 * every screen reader already knows and this is a form. The icon and the
 * chevron are painted UNDER it (`pointer-events-none`) and the select itself
 * is transparent on top, so the artboard's shape survives without inventing
 * a listbox. The word shown is the KIND word ("one of a list"), while the
 * options keep the fuller storage labels — a person picking the type wants
 * the distinction between "Date" and "Date and time"; a person reading the
 * row back does not.
 *
 * `types` narrows the list for a caller that cannot offer them all — the
 * spreadsheet wizard declares a column's type from its cells, and a header
 * row cannot say what a multiselect's options or a file column would be.
 */
export interface TypeSelectProps {
    t: TranslateFn;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    ariaLabel?: string;
    types?: { type: string; label: string; blurb: string; }[] | readonly { type: string; label: string; blurb: string; }[];
}

/** Create the table, or hand over to the link wizard for a mirror kind. */
export interface SubmitDraftArgs {
    nextcloud: boolean;
    spreadsheet: boolean;
    managed: boolean;
    target: string;
    name: string;
    effectiveKey: string;
    description: string;
    fields: TableColumn[];
    t: TranslateFn;
    onCreated: (table: { id: string }) => void;
    setPicking: (picking: string | null) => void;
    setBusy: (busy: boolean) => void;
    setError: (error: string | null) => void;
    setCreated: (created: CreatedResult | null) => void;
}
