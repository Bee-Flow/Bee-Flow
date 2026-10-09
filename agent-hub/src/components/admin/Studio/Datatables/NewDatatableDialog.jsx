import { Building2, ChevronDown, Cloud, FileSpreadsheet, Loader2, Plus, ShieldAlert, User, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import AiTablePanel from './AiTablePanel';
import ChoiceCard from './ChoiceCard';
import { ColumnKindIcon, kindWord } from './ColumnKind';
import { COLUMN_TYPES, SOURCE_KINDS, canLinkNextcloud, columnTypeKind, keyFromName, sourceErrorMessage, validateColumns } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import LinkNextcloudTablesDialog from './LinkNextcloudTablesDialog';
import LinkSpreadsheetDialog from './LinkSpreadsheetDialog';
import { ssReasonText } from './spreadsheet/wizardState';
import { checkPermission } from '../../../../hooks/usePermissionCheck';
import useTranslation from '../../../../hooks/useTranslation';
import { kindIcon, kindTileStyle } from '../../../shared/kindColors';
import Modal from '../../../shared/Modal';
import SegmentedControl from '../../../shared/SegmentedControl';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

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
export default function NewDatatableDialog({ scope = null, onClose, onCreated, user = null }) {
    const { t } = useTranslation();
    const [kind, setKind] = useState('plain');
    const [mode, setMode] = useState('simple');   // simple | advanced
    const [name, setName] = useState('');
    const [key, setKey] = useState('');
    const [keyTouched, setKeyTouched] = useState(false);
    const [description, setDescription] = useState('');
    const [fields, setFields] = useState([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // A managed table's answer carries the sentence about what its rows hold.
    // The dialog stays open on it: it is the one real reduction against the
    // hidden cache tier, and closing over it would make it a notification.
    const [created, setCreated] = useState(null);
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
    const [target, setTarget] = useState(canChoose ? 'organisation' : 'personal');

    const managed = kind === 'http_cache';
    const nextcloud = kind === 'nextcloud_table';
    const spreadsheet = kind === 'spreadsheet_file';
    // Either mirror kind: the table is named per table in the next step.
    const linking = nextcloud || spreadsheet;
    // A Nextcloud-bound organisation? Then ask the server what this account
    // could link — once, on open — so the card can say why it is off.
    const offerNextcloud = canLinkNextcloud(user);
    const [linkable, setLinkable] = useState(null);   // { connected, reason, tables } | null while loading
    const [picking, setPicking] = useState(null);     // null | 'nextcloud' | 'spreadsheet'
    const [linked, setLinked] = useState(null);       // a wizard's answer, tagged with its kind
    useEffect(() => {
        if (!offerNextcloud) return undefined;
        let alive = true;
        datatablesApi.linkable(canChoose ? undefined : 'personal')
            .then(b => { if (alive) setLinkable(b || { connected: false, reason: 'nextcloud_unavailable', tables: [] }); })
            .catch(e => { if (alive) setLinkable({ connected: false, reason: e?.code || 'nextcloud_unavailable', tables: [] }); });
        return () => { alive = false; };
    }, [offerNextcloud, canChoose]);
    // Which storages could a spreadsheet come from? Asked always (no client
    // pre-gate, see the header), answered cheaply, and never allowed to
    // break the dialog: [] is "no card".
    const [providers, setProviders] = useState(null);   // [{provider, connected, reason?}] | null while loading
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const b = await datatablesApi.spreadsheetProviders(canChoose ? undefined : 'personal');
                if (alive) setProviders(Array.isArray(b?.providers) ? b.providers : []);
            } catch {
                if (alive) setProviders([]);
            }
        })();
        return () => { alive = false; };
    }, [canChoose]);
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

    const submit = async (e) => {
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
            setError(messageFor(t, err));
        } finally {
            setBusy(false);
        }
    };

    if (picking === 'nextcloud') {
        return (
            <LinkNextcloudTablesDialog
                scope={target}
                linkable={linkable}
                onBack={() => setPicking(null)}
                onClose={onClose}
                onLinked={(body) => { setPicking(null); setLinked({ ...body, kind: 'nextcloud_table' }); }}
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
                onLinked={(body) => { setPicking(null); setLinked({ ...body, kind: 'spreadsheet_file' }); }}
            />
        );
    }

    if (linked) {
        const n = (linked.datatables || []).length;
        // The kind's own sentence about what happens next (the registry's
        // `linkedBody`); the title has no source in it and is shared.
        const spec = SOURCE_KINDS[linked.kind] || SOURCE_KINDS.nextcloud_table;
        return (
            <Modal
                open
                onClose={() => onCreated(linked.datatables[0])}
                title={<TitleRow kind="datatable" icon={spec.icon === 'spreadsheet' ? FileSpreadsheet : Cloud} text={t('datatables.nc_linked_title', 'The tables are ready')} />}
                size="md"
                className="sm:max-w-[520px]"
            >
                <div className="space-y-3">
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        {spec.linkedBody(t, n)}
                    </p>
                    {/* VERBATIM, like the managed warning: the server owns these sentences. */}
                    {(linked.warnings || []).map((w, i) => (
                        <p key={i} className="text-xs px-3 py-2 rounded-lg flex items-start gap-2"
                            style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
                            <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
                            <span>{w}</span>
                        </p>
                    ))}
                    <div className="flex justify-end">
                        <button type="button" onClick={() => onCreated(linked.datatables[0])}
                            className={`${BTN} font-medium`}
                            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                            {t('datatables.created_open', 'Open the table')}
                        </button>
                    </div>
                </div>
            </Modal>
        );
    }

    if (created) {
        return (
            <Modal
                open
                onClose={() => onCreated(created.datatable)}
                title={<TitleRow kind="datatable" text={t('datatables.created_title', 'The table is ready')} />}
                size="md"
                className="sm:max-w-[520px]"
            >
                <div className="space-y-3">
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        {t('datatables.created_managed', 'Automations can now point their “remember answers in a table” tick at it.')}
                    </p>
                    {/* VERBATIM. The server owns this sentence so it stays true
                        when the storage does; paraphrasing it here is how a
                        warning about plaintext survives a change that made it
                        wrong. */}
                    {created.warning && (
                        <p className="text-xs px-3 py-2 rounded-lg flex items-start gap-2"
                            style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
                            <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
                            <span>{created.warning}</span>
                        </p>
                    )}
                    <div className="flex justify-end">
                        <button type="button" onClick={() => onCreated(created.datatable)}
                            className={`${BTN} font-medium`}
                            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                            {t('datatables.created_open', 'Open the table')}
                        </button>
                    </div>
                </div>
            </Modal>
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
                <>
                    {/* The technical name is STATED even when its editor is
                        hidden: it is the identifier a Datatable step refers to,
                        and a person who never sees it cannot look their table
                        up later. */}
                    <span className="mr-auto text-[11px] min-w-0 truncate" style={{ color: 'var(--text-tertiary)' }}>
                        {nextcloud ? t('datatables.nc_footer', 'Names and technical names are chosen per table in the next step.')
                            : spreadsheet ? t('datatables.ss_footer', 'Names and technical names are chosen per sheet in the next step.') : (
                            <>
                                {t('datatables.technical_name', 'Technical name:')}{' '}
                                <code className="font-mono">{effectiveKey || '—'}</code>
                                {mode === 'simple' && (
                                    <>{' · '}{t('datatables.technical_name_hint', 'editable under All options')}</>
                                )}
                            </>
                        )}
                    </span>
                    <button type="button" onClick={onClose} className={`${BTN} border`}
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        {t('datatables.cancel', 'Cancel')}
                    </button>
                    {/* type=button + the same handler, not a form-associated
                        submit: the footer lives outside the <form> (the Modal
                        owns that slot), and cross-form association is one of
                        the places jsdom and browsers disagree. Enter inside a
                        field still submits, through the form's own onSubmit. */}
                    <button
                        type="button"
                        onClick={submit}
                        disabled={busy || !ready}
                        className={`${BTN} font-medium disabled:opacity-50 inline-flex items-center gap-1.5`}
                        style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                    >
                        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                        {nextcloud ? t('datatables.nc_choose', 'Choose tables…') : spreadsheet ? t('datatables.ss_choose', 'Choose files…') : t('datatables.create', 'Create')}
                    </button>
                </>
            )}
        >
            <form onSubmit={submit} className="space-y-4">
                <fieldset>
                    <legend className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                        {t('datatables.new_kind', 'What kind of table?')}
                    </legend>
                    <div className="grid grid-cols-2 gap-2">
                        <ChoiceCard
                            name="datatable-kind"
                            checked={kind === 'plain'}
                            onChange={() => setKind('plain')}
                            kind="datatable"
                            title={t('datatables.kind_plain', 'An ordinary table')}
                            blurb={t('datatables.kind_plain_blurb', 'You decide the columns. Automations read and write the rows.')}
                        />
                        <ChoiceCard
                            name="datatable-kind"
                            checked={managed}
                            onChange={() => setKind('http_cache')}
                            kind="app"
                            title={t('datatables.kind_http_cache', 'Web service answers')}
                            blurb={t('datatables.kind_http_cache_blurb', 'For the “remember answers in a table” tick on a Call a web service step. Its columns are fixed, because an automation writes them by name.')}
                        />
                        {offerNextcloud && (
                            <ChoiceCard
                                name="datatable-kind"
                                checked={nextcloud}
                                onChange={() => setKind('nextcloud_table')}
                                kind="datatable"
                                icon={<Cloud className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--type-data)' }} aria-hidden="true" />}
                                title={t('datatables.kind_nextcloud', 'A table from Nextcloud')}
                                blurb={t('datatables.kind_nextcloud_blurb', 'A copy of a Nextcloud Tables table or view, kept in step with it. Rows changed here are changed in Nextcloud; the columns are Nextcloud’s.')}
                                disabled={!!linkable && !linkable.connected}
                                note={linkable && !linkable.connected ? reasonText(t, linkable.reason) : null}
                            />
                        )}
                        {offerSpreadsheet && (
                            <ChoiceCard
                                name="datatable-kind"
                                checked={spreadsheet}
                                onChange={() => setKind('spreadsheet_file')}
                                kind="datatable"
                                icon={<FileSpreadsheet className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--type-data)' }} aria-hidden="true" />}
                                title={t('datatables.kind_spreadsheet', 'A spreadsheet from your files')}
                                blurb={t('datatables.kind_spreadsheet_blurb', 'A copy of a sheet in Google Drive, OneDrive or Nextcloud, kept in step with the file. Rows changed here are written to the file; the columns are the sheet’s header row.')}
                                disabled={!ssConnected}
                                note={!ssConnected ? ssReasonText(t, providers[0]) : null}
                            />
                        )}
                    </div>
                </fieldset>

                {kind === 'plain' && (
                    <AiTablePanel
                        mode="create"
                        compact
                        current={{ name, description, fields }}
                        onApply={(d) => {
                            // Undo hands back what the dialog held; a draft fills
                            // name, purpose and columns and lets the key follow the
                            // name again. Nothing is created until "Create".
                            setName(d.name || '');
                            setDescription(d.description || '');
                            setFields((Array.isArray(d.fields) ? d.fields : []).map(f => ({
                                key: f.key, name: f.name, type: f.type,
                                ...(f.options ? { options: f.options } : {}),
                                ...(f.required ? { required: true } : {}),
                            })));
                            if (!d.undo) setKeyTouched(false);
                        }}
                        testId="new-table-ai"
                    />
                )}

                {!linking && (
                <label className="block">
                    <span className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                        {t('datatables.field_name', 'Name')}
                    </span>
                    <input
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('studio_misc.newtable.name_placeholder', 'Customers')}
                        className={INPUT}
                        style={INPUT_STYLE}
                    />
                </label>
                )}

                {!linking && mode === 'advanced' && (
                    <label className="block">
                        <span className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                            {t('datatables.field_key', 'Technical name')}
                        </span>
                        <input
                            value={effectiveKey}
                            onChange={(e) => { setKeyTouched(true); setKey(e.target.value); }}
                            placeholder={t('studio_misc.newtable.key_placeholder', 'customers')}
                            className={`${INPUT} font-mono`}
                            style={INPUT_STYLE}
                        />
                        <span className="block text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                            {t('datatables.field_key_help', 'Lowercase letters, numbers and underscores. Renaming it later means moving the data, so it is worth a moment now.')}
                        </span>
                    </label>
                )}

                {!linking && (
                <label className="block">
                    <span className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                        {t('datatables.field_purpose', 'What is it for?')}
                    </span>
                    <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={2}
                        placeholder={t('studio_misc.newtable.purpose_placeholder', 'Customers we have already sent the onboarding e-mail to.')}
                        className={INPUT}
                        style={INPUT_STYLE}
                    />
                    <span className="block text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                        {managed
                            ? t('datatables.field_purpose_managed', 'Optional here — left empty, this kind of table brings its own sentence for the processing record.')
                            : t('datatables.field_purpose_help', 'Required — this sentence goes into your organisation’s processing record.')}
                    </span>
                </label>
                )}

                {!managed && !linking && (
                    <FirstColumns t={t} fields={fields} problems={columnProblems} onChange={setFields} />
                )}

                {canChoose ? (
                    <fieldset className="block">
                        <legend className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                            {t('datatables.field_audience', 'Who is it for?')}
                        </legend>
                        <div className="grid grid-cols-2 gap-2">
                            <ChoiceCard
                                name="datatable-scope"
                                icon={<Building2 className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />}
                                checked={target === 'organisation'}
                                onChange={() => setTarget('organisation')}
                                title={t('datatables.scope_org', 'Your organisation')}
                                blurb={t('datatables.scope_org_blurb', 'You decide afterwards who may read or change the rows. Automations your colleagues own can use it.')}
                            />
                            <ChoiceCard
                                name="datatable-scope"
                                icon={<User className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />}
                                checked={target === 'personal'}
                                onChange={() => setTarget('personal')}
                                title={t('datatables.scope_personal', 'This account only')}
                                blurb={t('datatables.scope_personal_blurb', 'Only this account can see the rows — not colleagues, not administrators. It cannot be shared later.')}
                            />
                        </div>
                    </fieldset>
                ) : (
                    <p className="text-[11px] px-3 py-2 rounded-lg flex items-start gap-2"
                        style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}>
                        <User className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                        <span>
                            {t('datatables.scope_personal_blurb', 'Only this account can see the rows — not colleagues, not administrators. It cannot be shared later.')}
                            {orgScopeWithheld && (
                                <>
                                    {' '}
                                    {/* The sentence carries the words; the title
                                        keeps the exact permission id, so the
                                        administrator this gets forwarded to has
                                        the string to grant and does not have to
                                        guess it back out of the copy. */}
                                    <span title={ORG_SCOPE_PERMISSION} className="underline decoration-dotted">
                                        {t('datatables.scope_org_not_permitted', 'Making one for the whole organisation needs a permission this account does not have — an administrator grants it under Organisation → Roles.')}
                                    </span>
                                </>
                            )}
                        </span>
                    </p>
                )}

                {error && (
                    <p role="alert" className="text-xs px-3 py-2 rounded-lg"
                        style={{ background: 'var(--bg-primary)', color: 'var(--warning)' }}>
                        {error}
                    </p>
                )}
            </form>
        </Modal>
    );
}

const INPUT = 'w-full px-3 py-2 rounded-lg text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1';
// --bg-primary, not --bg-secondary: the Modal panel is itself --bg-secondary,
// so an input painted the same colour has no edge at all.
const INPUT_STYLE = {
    background: 'var(--bg-primary)', borderColor: 'var(--border-default)',
    color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)',
};
const BTN = 'px-3 py-2 rounded-[10px] text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

/**
 * The permission POST /api/datatables asks for before it will put a table in
 * an organisation — spelled exactly as the server spells it, because this
 * string is what an administrator types into Organisation → Roles.
 */
const ORG_SCOPE_PERMISSION = 'manage_datatables';

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
function mayCreateOrgTable(user) {
    const stated = Array.isArray(user?.permissions) || typeof user?.isAdmin === 'boolean';
    if (!stated) return true;
    return checkPermission(user, ORG_SCOPE_PERMISSION);
}

/** The 28px kind tile beside the dialog's own name — the section header's own recipe. */
export function TitleRow({ kind, text, icon = null }) {
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
function FirstColumns({ t, fields, problems, onChange }) {
    const set = (i, patch) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
    return (
        <div className="space-y-2">
            <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {t('datatables.first_columns', 'Columns')}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {t('datatables.first_columns_hint', 'optional · can also be added later')}
                </span>
            </div>
            {fields.map((f, i) => (
                <div key={i} className="grid gap-2 items-center" style={{ gridTemplateColumns: 'minmax(0,1fr) 160px 28px' }}>
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
                        className="p-1 rounded justify-self-center focus-visible:outline focus-visible:outline-2"
                        style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}>
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                </div>
            ))}
            <button
                type="button"
                onClick={() => onChange([...fields, { key: '', name: '', type: 'text' }])}
                className="text-xs inline-flex items-center gap-1.5 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}
            >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.column_add', 'Add a column')}
            </button>
            {problems.length > 0 && (
                <ul role="alert" className="text-xs space-y-1 px-3 py-2 rounded-lg"
                    style={{ background: 'var(--bg-primary)', color: 'var(--warning)' }}>
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
export function TypeSelect({ t, value, onChange, disabled = false, ariaLabel, types = COLUMN_TYPES }) {
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
                <ChevronDown className="w-3 h-3 ml-auto shrink-0" style={{ color: 'var(--text-tertiary)' }} />
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
function messageFor(t, err) {
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

/** Why the Nextcloud card is off right now — the server's reason, as a sentence. */
function reasonText(t, reason) {
    switch (reason) {
        case 'nc_scope_denied':
            return t('datatables.nc_reason_scope_off', 'Bee Flow may not read this account’s Nextcloud tables yet. Switch Tables on under Settings → Connections → Nextcloud.');
        case 'nextcloud_integration_off':
            return t('datatables.nc_reason_integration_off', 'Nextcloud Tables is switched off for this organisation. An administrator can switch it on under Organisation → Nextcloud.');
        case 'not_nc_org':
            return t('datatables.err_not_nc_org', 'This organisation is not connected to Nextcloud.');
        default:
            return t('datatables.nc_reason_unavailable', 'Nextcloud could not be reached just now.');
    }
}
