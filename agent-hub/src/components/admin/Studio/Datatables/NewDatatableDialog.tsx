import { ChevronDown, Cloud, FileSpreadsheet, Plus, X, type LucideIcon } from 'lucide-react';
import React, { useState } from 'react';
import AiTablePanel from './AiTablePanel';
import { ColumnKindIcon, kindWord } from './ColumnKind';
import { COLUMN_TYPES, SOURCE_KINDS, canLinkNextcloud, columnTypeKind, keyFromName, sourceErrorMessage, validateColumns } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import LinkNextcloudTablesDialog from './LinkNextcloudTablesDialog';
import LinkSpreadsheetDialog from './LinkSpreadsheetDialog';
import AudienceChoice from './newDatatable/AudienceChoice';
import { INPUT, INPUT_STYLE, ORG_SCOPE_PERMISSION } from './newDatatable/constants';
import CreatedResultModal from './newDatatable/CreatedResultModal';
import KindChoice from './newDatatable/KindChoice';
import LinkedResultModal from './newDatatable/LinkedResultModal';
import NewDatatableFooter from './newDatatable/NewDatatableFooter';
import NewTableFields from './newDatatable/NewTableFields';
import { useLinkSources } from './newDatatable/useLinkSources';
import { checkPermission, type PermissionUser } from '../../../../hooks/usePermissionCheck';
import useTranslation from '../../../../hooks/useTranslation';
import { kindIcon, kindTileStyle } from '../../../shared/kindColors';
import Modal from '../../../shared/Modal';
import SegmentedControl from '../../../shared/SegmentedControl';
import type { TableColumn } from '../AppStudio/inspector/aiFieldMatching';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { WizardError } from './spreadsheet/wizardState';
import type { ConnectionOption } from '../Solutions/pipeline/settings/stageSettingsApi';
import type { AiTableDraft } from './AiTablePanel';

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
interface NewDatatableDialogProps {
    scope?: ConnectionOption | null;
    onClose: () => void;
    onCreated: (table: { id: string }) => void;
    user?: PermissionUser | null;
}

/** A wizard's answer: the tables it made and the warnings to read. */
interface LinkedBody {
    datatables: Array<{ id: string }>;
    warnings?: string[];
}

/** A wizard's answer, tagged with its kind. */
interface LinkedResult extends LinkedBody {
    kind: 'nextcloud_table' | 'spreadsheet_file';
}

/** A managed table's answer. */
interface CreatedResult {
    datatable: { id: string };
    warning?: string;
}

export default function NewDatatableDialog({ scope = null, onClose, onCreated, user = null }: NewDatatableDialogProps) {
    const { t } = useTranslation();
    const [kind, setKind] = useState('plain');
    const [mode, setMode] = useState('simple');   // simple | advanced
    const [name, setName] = useState('');
    const [key, setKey] = useState('');
    const [keyTouched, setKeyTouched] = useState(false);
    const [description, setDescription] = useState('');
    const [fields, setFields] = useState<TableColumn[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // A managed table's answer carries the sentence about what its rows hold.
    // The dialog stays open on it: it is the one real reduction against the
    // hidden cache tier, and closing over it would make it a notification.
    const [created, setCreated] = useState<CreatedResult | null>(null);
    const { canChoose, orgScopeWithheld } = orgScopeChoice(scope, user);
    const [target, setTarget] = useState(canChoose ? 'organisation' : 'personal');

    const managed = kind === 'http_cache';
    const nextcloud = kind === 'nextcloud_table';
    const spreadsheet = kind === 'spreadsheet_file';
    // Either mirror kind: the table is named per table in the next step.
    const linking = nextcloud || spreadsheet;
    // A Nextcloud-bound organisation? Then ask the server what this account
    // could link — once, on open — so the card can say why it is off.
    const offerNextcloud = canLinkNextcloud(user);
    const [picking, setPicking] = useState<string | null>(null);     // null | 'nextcloud' | 'spreadsheet'
    const [linked, setLinked] = useState<LinkedResult | null>(null);       // a wizard's answer, tagged with its kind
    const { linkable, providers } = useLinkSources(offerNextcloud, canChoose);
    const offerSpreadsheet = !!(providers && providers.length);
    const ssConnected = !!(providers && providers.some(p => p.connected));

    const effectiveKey = keyTouched ? key : keyFromName(name);
    const columnProblems = validateColumns(fields);
    // A managed table's description is optional here ONLY because the server
    // fills in its own sentence; on an ordinary table an empty one is a 400.
    // A mirror is named per table in the next step.
    const ready = nextcloud
        ? !!(linkable && linkable.connected)
        : spreadsheet
            ? ssConnected
            : (!!name.trim() && !!effectiveKey && (managed || !!description.trim()) && columnProblems.length === 0);

    const submit = (e: React.SyntheticEvent<Element, Event> | React.SubmitEvent<HTMLFormElement>) => submitDraft(e, {
        nextcloud, spreadsheet, managed, target, name, effectiveKey, description, fields, t, onCreated,
        setPicking, setBusy, setError, setCreated,
    });

    if (picking === 'nextcloud') {
        return (
            <LinkNextcloudTablesDialog
                scope={target}
                linkable={linkable}
                onBack={() => setPicking(null)}
                onClose={onClose}
                onLinked={(body: unknown) => { setPicking(null); setLinked({ ...(body as LinkedBody), kind: 'nextcloud_table' }); }}
            />
        );
    }

    if (picking === 'spreadsheet') {
        return (
            <LinkSpreadsheetDialog
                scope={target}
                providers={providers || []}
                onBack={() => setPicking(null)}
                onClose={onClose}
                onLinked={(body: unknown) => { setPicking(null); setLinked({ ...(body as LinkedBody), kind: 'spreadsheet_file' }); }}
            />
        );
    }

    if (linked) {
        const n = (linked.datatables || []).length;
        // The kind's own sentence about what happens next (the registry's
        // `linkedBody`); the title has no source in it and is shared.
        const spec = SOURCE_KINDS[linked.kind] || SOURCE_KINDS.nextcloud_table;
        return (
            <LinkedResultModal
                title={<TitleRow kind="datatable" icon={spec.icon === 'spreadsheet' ? FileSpreadsheet : Cloud} text={t('datatables.nc_linked_title', 'The tables are ready')} />}
                body={spec.linkedBody(t, n)}
                warnings={linked.warnings || []}
                onOpen={() => onCreated(linked.datatables[0])}
                t={t}
            />
        );
    }

    if (created) {
        return (
            <CreatedResultModal
                title={<TitleRow kind="datatable" text={t('datatables.created_title', 'The table is ready')} />}
                warning={created.warning}
                onOpen={() => onCreated(created.datatable)}
                t={t}
            />
        );
    }

    return (
        <Modal
            open
            onClose={onClose}
            size="md"
            className="sm:max-w-[520px]"
            title={<TitleRow kind={managed ? 'app' : 'datatable'} icon={nextcloud ? Cloud : spreadsheet ? FileSpreadsheet : null} text={t('datatables.new_title', 'New datatable')} />}
            headerActions={linking ? null : (
                <SegmentedControl
                    size="sm"
                    ariaLabel={t('datatables.detail_level', 'How much to show')}
                    value={mode}
                    onChange={setMode}
                    options={[
                        { value: 'simple', label: t('datatables.simple', 'Simple') },
                        { value: 'advanced', label: t('datatables.all_options', 'All options') },
                    ]}
                />
            )}
            footer={(
                <NewDatatableFooter
                    nextcloud={nextcloud}
                    spreadsheet={spreadsheet}
                    effectiveKey={effectiveKey}
                    mode={mode}
                    onClose={onClose}
                    submit={submit}
                    busy={busy}
                    ready={ready}
                    t={t}
                />
            )}
        >
            <form onSubmit={submit} className="space-y-4">
                <KindChoice
                    kind={kind}
                    setKind={setKind}
                    managed={managed}
                    nextcloud={nextcloud}
                    spreadsheet={spreadsheet}
                    offerNextcloud={offerNextcloud}
                    offerSpreadsheet={offerSpreadsheet}
                    linkable={linkable}
                    ssConnected={ssConnected}
                    providers={providers || []}
                    t={t}
                />

                {kind === 'plain' && (
                    <AiTablePanel
                        mode="create"
                        compact
                        current={{ name, description, fields }}
                        onApply={(d) => applyDraft(d, { setName, setDescription, setFields, setKeyTouched })}
                        testId="new-table-ai"
                    />
                )}

                <NewTableFields
                    linking={linking}
                    managed={managed}
                    mode={mode}
                    name={name}
                    setName={setName}
                    effectiveKey={effectiveKey}
                    setKey={setKey}
                    setKeyTouched={setKeyTouched}
                    description={description}
                    setDescription={setDescription}
                    firstColumns={<FirstColumns t={t} fields={fields} problems={columnProblems} onChange={setFields} />}
                    t={t}
                />

                <AudienceChoice canChoose={canChoose} orgScopeWithheld={orgScopeWithheld} target={target} setTarget={setTarget} t={t} />

                {error && (
                    <p role="alert" className="text-xs px-3 py-2 rounded-lg bg-[var(--bg-primary)] text-[var(--warning)]">
                        {error}
                    </p>
                )}
            </form>
        </Modal>
    );
}

/**
 * May this account create an ORGANISATION table?
 *
 * Three answers, not two, and the third is the one worth writing down. The
 * dialog is handed a session, and a session that carries no permission facts
 * at ALL — no `permissions` array, no `isAdmin` — has not told us "no", it has
 * told us nothing. Reading that silence as a refusal would hide the
 * organisation card from the org admin the Studio section exists for, on every
 * call site that never passed a user. So unknown keeps the choice; only a
 * session that states its permissions and lacks this one loses it, and the
 * server stays the authority either way.
 */
function mayCreateOrgTable(user: PermissionUser | null) {
    const stated = Array.isArray(user?.permissions) || typeof user?.isAdmin === 'boolean';
    if (!stated) return true;
    return checkPermission(user, ORG_SCOPE_PERMISSION);
}

/** The 28px kind tile beside the dialog's own name — the section header's own recipe. */
interface TitleRowProps {
    kind: string;
    text: string;
    icon?: LucideIcon | null;
}

export function TitleRow({ kind, text, icon = null }: TitleRowProps) {
    const { tile, glyph } = kindTileStyle(kind, { size: 28, pct: 18 });
    // `icon` overrides the kind's glyph (a Nextcloud table wears the cloud).
    // createElement rather than a `Glyph` variable: a component assigned in
    // render trips react-hooks/static-components, and this is not one.
    const glyphType = icon || kindIcon(kind);
    return (
        <span className="flex items-center gap-2.5">
            <span style={tile} aria-hidden="true">{glyphType ? React.createElement(glyphType, { style: glyph }) : null}</span>
            <span className="text-[14px] font-semibold">{text}</span>
        </span>
    );
}

/**
 * The first column or two, so a new table is usable without a second trip.
 *
 * Deliberately thin — name and type only. The Columns tab is where options,
 * reordering and the destructive-change guard live, and duplicating any of
 * that here would mean two places that can disagree about what a column is.
 */
interface FirstColumnsProps {
    t: TranslateFn;
    fields: TableColumn[];
    problems: string[];
    onChange: (fields: TableColumn[]) => void;
}

function FirstColumns({ t, fields, problems, onChange }: FirstColumnsProps) {
    const set = (i: number, patch: Partial<TableColumn>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
    return (
        <div className="space-y-2">
            <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">
                    {t('datatables.first_columns', 'Columns')}
                </span>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                    {t('datatables.first_columns_hint', 'optional · can also be added later')}
                </span>
            </div>
            {fields.map((f, i) => (
                <div key={i} className="grid gap-2 items-center [grid-template-columns:minmax(0,1fr)_160px_28px]">
                    <input
                        value={f.name}
                        onChange={(e) => set(i, { name: e.target.value, key: keyFromName(e.target.value) })}
                        placeholder={t('datatables.column_name', 'Column name')}
                        aria-label={t('datatables.column_name', 'Column name')}
                        className={INPUT}
                        style={INPUT_STYLE}
                    />
                    <TypeSelect t={t} value={f.type} onChange={(type) => set(i, { type })} />
                    <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))}
                        aria-label={t('datatables.column_remove', 'Remove this column')}
                        className="p-1 rounded justify-self-center focus-visible:outline focus-visible:outline-2 [color:var(--text-tertiary)] [outline-color:var(--accent-primary)]!">
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                </div>
            ))}
            <button
                type="button"
                onClick={() => onChange([...fields, { key: '', name: '', type: 'text' }])}
                className="text-xs inline-flex items-center gap-1.5 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [color:var(--text-secondary)]! [outline-color:var(--accent-primary)]!"
            >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.column_add', 'Add a column')}
            </button>
            {problems.length > 0 && (
                <ul role="alert" className="text-xs space-y-1 px-3 py-2 rounded-lg bg-[var(--bg-primary)] text-[var(--warning)]">
                    {problems.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
            )}
        </div>
    );
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
interface TypeSelectProps {
    t: TranslateFn;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    ariaLabel?: string;
    types?: { type: string; label: string; blurb: string; }[] | readonly { type: string; label: string; blurb: string; }[];
}

export function TypeSelect({ t, value, onChange, disabled = false, ariaLabel, types = COLUMN_TYPES }: TypeSelectProps) {
    const kind = columnTypeKind(value);
    return (
        <span className="relative block min-w-0">
            <span
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs border pointer-events-none"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', opacity: disabled ? 0.6 : 1 }}
                aria-hidden="true"
            >
                <ColumnKindIcon kind={kind} size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                <span className="truncate">{kindWord(t, kind)}</span>
                <ChevronDown className="w-3 h-3 ml-auto shrink-0 text-[var(--text-tertiary)]" />
            </span>
            <select
                value={value || 'text'}
                disabled={disabled}
                aria-label={ariaLabel || t('datatables.column_type', 'Column type')}
                onChange={(e) => onChange(e.target.value)}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-default"
            >
                {types.map(ct => <option key={ct.type} value={ct.type}>{t(`studio_misc.coltype.${ct.type}`, ct.label)}</option>)}
            </select>
        </span>
    );
}

/** What each machine-readable refusal means to a person. */
function messageFor(t: TranslateFn, err: WizardError) {
    const source = sourceErrorMessage(t, err);
    if (source) return source;
    switch (err?.code) {
        case 'key_taken': return t('datatables.err_key_taken', 'There is already a table with this key. Pick another one.');
        case 'no_organisation': return t('datatables.err_no_org', 'This account is not in an organisation, so it can only make a personal table.');
        case 'quota_exceeded': return t('datatables.err_quota', 'You have reached the limit on tables here.');
        case 'bad_scope': return t('datatables.err_bad_scope', 'Choose whether the table is for your organisation or for this account.');
        case 'unknown_managed_kind': return t('datatables.err_unknown_kind', 'This workspace does not know how to fill in that kind of table.');
        default: return err?.message || t('datatables.err_create', 'Could not create the table');
    }
}

/**
 * Whether this account may CHOOSE the organisation, and whether the choice is
 * missing only because a permission is.
 */
function orgScopeChoice(scope: ConnectionOption | null, user: PermissionUser | null) {
    // The server's default for this caller, so the dialog opens on the answer
    // it would have given. Keyed on 'org' rather than on NOT-'user', because
    // the list can also answer `scope: null` (no tenancy at all): the old
    // condition then showed the personal sentence and submitted `organisation`,
    // which is the shape of copy-says-one-thing-request-says-another that sent
    // BFSF-412 round twice.
    //
    // And the tenancy is only half the question. The choice needs BOTH a
    // tenancy to put a table in and the permission the server asks for before
    // it will accept one; offering it on the tenancy alone is the same failure
    // one layer down, answered after the click by a 403 instead of before it.
    const mayUseOrgScope = mayCreateOrgTable(user);
    const canChoose = scope?.kind === 'org' && mayUseOrgScope;
    // The organisation is there, the permission is not — the one case that
    // gets its own sentence, because a missing card with no explanation reads
    // as a product that forgot the feature.
    const orgScopeWithheld = scope?.kind === 'org' && !mayUseOrgScope;
    return { canChoose, orgScopeWithheld };
}

/** Create the table, or hand over to the link wizard for a mirror kind. */
interface SubmitDraftArgs {
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

async function submitDraft(e: React.SyntheticEvent<Element, Event> | React.SubmitEvent<HTMLFormElement>, {
    nextcloud, spreadsheet, managed, target, name, effectiveKey, description, fields, t, onCreated,
    setPicking, setBusy, setError, setCreated,
}: SubmitDraftArgs) {
    e.preventDefault();
    if (nextcloud) { setPicking('nextcloud'); return; }
    if (spreadsheet) { setPicking('spreadsheet'); return; }
    setBusy(true);
    setError(null);
    try {
        if (managed) {
            const body = await datatablesApi.createManaged({
                kind: 'http_cache',
                scope: target,
                name: name.trim(),
                key: effectiveKey,
                // Omitted, not blanked: undefined is what makes the server
                // use its own Art. 30 sentence for the kind.
                ...(description.trim() ? { description: description.trim() } : {}),
            });
            setCreated(body);
        } else {
            const body = await datatablesApi.create({
                scope: target,
                name: name.trim(),
                key: effectiveKey,
                description: description.trim(),
                fields: fields.map(f => ({ key: f.key, name: f.name, type: f.type, ...(f.options ? { options: f.options } : {}) })),
            });
            onCreated(body.datatable);
        }
    } catch (err) {
        // Read the CODE, not the sentence: the server's wording is a
        // server-side decision and a client that matches on it breaks the
        // day somebody improves the copy.
        setError(messageFor(t, err as WizardError));
    } finally {
        setBusy(false);
    }
}

/** An AI draft (or its undo) fills the dialog; nothing is created until "Create". */
function applyDraft(d: AiTableDraft, { setName, setDescription, setFields, setKeyTouched }: {
    setName: (name: string) => void;
    setDescription: (description: string) => void;
    setFields: (fields: TableColumn[]) => void;
    setKeyTouched: (touched: boolean) => void;
}) {
    // Undo hands back what the dialog held; a draft fills
    // name, purpose and columns and lets the key follow the
    // name again. Nothing is created until "Create".
    setName(d.name || '');
    setDescription(d.description || '');
    setFields((Array.isArray(d.fields) ? d.fields as TableColumn[] : []).map(f => ({
        key: f.key, name: f.name, type: f.type,
        ...(f.options ? { options: f.options } : {}),
        ...(f.required ? { required: true } : {}),
    })));
    if (!d.undo) setKeyTouched(false);
}
