import { AlertTriangle, Building2, Loader2, Plus, Search, User } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import DatatableCard from './DatatableCard';
import DatatableDetail from './DatatableDetail';
import { datatablesApi } from './datatablesApi';
import NewDatatableDialog from './NewDatatableDialog';
import useTranslation from '../../../../hooks/useTranslation';
import EmptyState from '../../../shared/EmptyState';
import { kindIcon, kindTileStyle } from '../../../shared/kindColors';
import StudioSectionHeader, { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

/**
 * Studio → Datatables: the tables automations read and write between runs.
 *
 * Why this is a Studio section and not a panel inside the builder: a table
 * OUTLIVES the automation that created it, and is usually read by a different
 * one. Something whose lifetime is longer than any one canvas cannot be
 * managed from inside a canvas — you would be editing the shape of shared org
 * data from inside a document, with no way to see who else depends on it. The
 * "Used by" list on the detail exists for exactly that: the answer to "may I
 * delete this column" is another automation, not this one.
 *
 * The list is already filtered by the SERVER's grade resolver
 * (auth/datatableAccess), the same one the runner uses, so a table nobody
 * shared with you is not merely hidden here — it is not probeable at all
 * (404, never 403, for a table you hold no grade on).
 *
 * ── SAY WHERE A NEW TABLE WOULD GO, BEFORE OFFERING TO MAKE ONE ─────
 * The list response carries `scope`: the organisation, or this account alone.
 * It is stated above the button rather than discovered afterwards, because the
 * two are not the same promise — one is shared with colleagues, the other is
 * not — and because an inviting empty state over a create the API would refuse
 * is what sent BFSF-412 round twice.
 *
 * ── THE SEARCH BOX IS ALWAYS THERE ──────────────────────────────────
 * It used to appear only past four tables. That is a control that moves: the
 * person who learns where it is at six tables cannot find it at three, and
 * the box costs one row. The artboard draws it beside the heading at every
 * length, which is the deviation this file makes on purpose (the >4 rule was
 * pinned by hygiene.test.jsx and the test moved with it).
 */
export default function DatatablesStudio({ user = null, hasPermission = () => true, initialDatatableId = null, initialDatatableTab = null, onNavigate = null }) {
    const { t } = useTranslation();
    const [tables, setTables] = useState([]);
    const [scope, setScope] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [openId, setOpenId] = useState(initialDatatableId || null);
    const [creating, setCreating] = useState(false);
    const [query, setQuery] = useState('');

    const canManage = hasPermission('manage_datatables');
    // `manage_datatables` lives under org_admin/agent_admin, and the server
    // asks for it only on an ORGANISATION table. Hiding the button on the
    // permission alone is what left the account this feature exists for with
    // nowhere to click.
    const canCreate = scope?.kind === 'user' || canManage;

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const body = await datatablesApi.list();
            setTables(Array.isArray(body?.datatables) ? body.datatables : []);
            setScope(body?.scope || null);
        } catch (e) {
            setError(e.message || t('datatables.err_list', 'Could not load your datatables'));
            setTables([]);
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => { load(); }, [load]);

    // Adopt deep-link changes, INCLUDING the change to null — the Approvals
    // pattern. Only adopting truthy ids leaves a detail open after Back.
    const lastInitial = React.useRef(initialDatatableId);
    useEffect(() => {
        if (initialDatatableId !== lastInitial.current) {
            lastInitial.current = initialDatatableId;
            setOpenId(initialDatatableId || null);
        }
    }, [initialDatatableId]);

    const open = useCallback((id) => {
        setOpenId(id);
        if (onNavigate) onNavigate(id ? `studio/datatables/${id}` : 'studio/datatables');
    }, [onNavigate]);

    const openTable = useMemo(() => tables.find(x => x.id === openId) || null, [tables, openId]);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return tables;
        return tables.filter(x => [x.name, x.key, x.description]
            .some(v => String(v || '').toLowerCase().includes(q)));
    }, [tables, query]);

    if (openId && openTable) {
        return (
            <DatatableDetail
                table={openTable}
                // The id, not the whole user object: the panel needs exactly
                // one thing from it — whether a consumer in the Used-by list is
                // this account's, and so has a page it can actually open.
                currentUserId={user?.id || null}
                canManage={canManage}
                onBack={() => open(null)}
                onChanged={load}
                onDeleted={() => { open(null); load(); }}
                onNavigate={onNavigate}
                initialTab={initialDatatableTab}
            />
        );
    }

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <StudioSectionHeader
                kind="datatable"
                title={t('datatables.title', 'Datatables')}
                primary={canCreate ? (
                    <button
                        type="button"
                        onClick={() => setCreating(true)}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                    >
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('datatables.new', 'New table')}
                    </button>
                ) : null}
            />

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto px-6 py-8 space-y-4" style={{ maxWidth: 760 }}>
                    <div className="flex items-end gap-3">
                        <div className="flex-1 min-w-0">
                            <h2 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                                {t('datatables.heading', 'Tables')}
                                {!loading && !error && tables.length > 0 && (
                                    <span className="ml-2 font-medium" style={{ color: 'var(--text-tertiary)' }}>
                                        {tables.length}
                                    </span>
                                )}
                            </h2>
                            <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                                {t('datatables.intro', 'Rows that stay put after a run ends. An automation can read back what an earlier run wrote, and other automations can use the same table.')}
                            </p>
                        </div>
                        <SearchBox t={t} value={query} onChange={setQuery} />
                    </div>

                    {!loading && canCreate && <ScopeNotice t={t} scope={scope} />}

                    {/* `&& !error` — a load that THREW leaves openTable null too, so
                        without this a legitimate owner whose request failed was told
                        the table was not available to them, with the real error
                        printed underneath it contradicting it on screen. */}
                    {openId && !openTable && !loading && !error && (
                        <p className="px-3 py-2.5 rounded-lg text-sm flex items-start gap-2"
                            style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                            {/* Never "you do not have access": whether it was deleted or
                                simply never shared is exactly what the 404 refuses to
                                reveal, and the copy must not undo that. */}
                            {t('datatables.not_available', 'That table is not available to you.')}
                        </p>
                    )}

                    <div aria-live="polite">
                        {loading ? (
                            <div className="flex items-center justify-center py-12" style={{ color: 'var(--text-tertiary)' }}>
                                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                                <span className="sr-only">{t('datatables.loading', 'Loading…')}</span>
                            </div>
                        ) : error ? (
                            <p className="px-3 py-2.5 rounded-lg text-sm"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--warning)' }}>
                                {error}
                            </p>
                        ) : tables.length === 0 ? (
                            <NoTablesYet t={t} canCreate={canCreate} onCreate={() => setCreating(true)} />
                        ) : shown.length === 0 ? (
                            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                                {t('datatables.search_empty', 'No table matches that.')}
                            </p>
                        ) : (
                            <ul className="space-y-2">
                                {shown.map(x => <DatatableCard key={x.id} t={t} table={x} onOpen={() => open(x.id)} />)}
                            </ul>
                        )}
                    </div>
                </div>
            </div>

            {creating && (
                <NewDatatableDialog
                    scope={scope}
                    // For the third card: is this account's organisation bound
                    // to Nextcloud, and is the beta on for it (canLinkNextcloud).
                    user={user}
                    onClose={() => setCreating(false)}
                    onCreated={(x) => { setCreating(false); load(); open(x.id); }}
                />
            )}
        </div>
    );
}

/** The 200px box beside the heading — present at every list length. */
function SearchBox({ t, value, onChange }) {
    const label = t('datatables.search', 'Search tables by name, key or purpose…');
    return (
        <label className="relative block shrink-0" style={{ width: 200 }}>
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={t('datatables.search_short', 'Search a table…')}
                aria-label={label}
                className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                style={{
                    background: 'var(--bg-card)', borderColor: 'var(--border-default)',
                    color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)',
                }}
            />
        </label>
    );
}

/**
 * One line saying where a new table would go.
 *
 * "this account", never "you": on a self-hosted install the built-in `admin`
 * login is routinely shared between several human operators, so "only you can
 * see it" would be a promise the product cannot keep.
 */
function ScopeNotice({ t, scope }) {
    if (!scope) return null;
    const personal = scope.kind === 'user';
    const Icon = personal ? User : Building2;
    return (
        <p className="flex items-start gap-2 text-xs"
            style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
            <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <span>
                {personal
                    ? t('datatables.scope_notice_personal', 'New tables here are personal — only this account can see them, and they cannot be shared.')
                    : t('datatables.scope_notice_org', 'New tables here belong to your organisation. You choose afterwards who may read or change them.')}
            </span>
        </p>
    );
}

/**
 * The dashed placard of artboard 1a, around the shared EmptyState.
 *
 * The button is NOT EmptyState's own `action`: that one paints white text on
 * the accent, and --accent-primary is a light grey in three of the five
 * themes. Every filled button in this section uses the accent's paired
 * foreground token instead.
 */
function NoTablesYet({ t, canCreate, onCreate }) {
    const { tile, glyph } = kindTileStyle('datatable', { size: 44, pct: 14 });
    const Glyph = kindIcon('datatable');
    return (
        <div className="flex flex-col items-center"
            style={{ border: '1px dashed var(--border-default)', borderRadius: 12, background: 'var(--bg-card)' }}>
            <EmptyState
                icon={<span style={tile}>{Glyph && <Glyph style={glyph} />}</span>}
                title={t('datatables.empty_title', 'No datatables yet')}
                description={canCreate
                    ? t('datatables.empty_can_create', 'Make one when an automation needs to remember something between runs — a list of customers it has already e-mailed, a running total, rows a second automation picks up.')
                    // An empty state that does not say WHY reads as broken. This
                    // one names the person who can fix it — and it is only shown
                    // when creating really is refused, never over a scope the
                    // caller could have used.
                    : t('datatables.empty_cannot_create', 'Tables in this organisation are created by an administrator. Once one is shared with you it appears here, and your automations can use it.')}
            />
            {canCreate && (
                <button
                    type="button"
                    onClick={onCreate}
                    className="inline-flex items-center gap-1.5 h-8 px-3 mb-10 -mt-4 rounded-[10px] text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('datatables.new', 'New table')}
                </button>
            )}
        </div>
    );
}
