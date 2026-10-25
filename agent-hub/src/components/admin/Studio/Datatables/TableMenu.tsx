import { Check, Copy, Download, Ellipsis, ExternalLink, Loader2, Pencil, Stethoscope, Tag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isNcMirror, sourceNameOf, sourceUrlOf } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import useCopyToClipboard from '../../../../hooks/useCopyToClipboard';
import AnchoredMenu from '../../../shared/AnchoredMenu';
import Modal from '../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import type { MirrorSource } from './sourceMirrors';
import type { DetailTable, TableHealth, TableMenuProps, HealthDialogProps } from './DatatableDetail.types';

/** Is this SPA running inside Nextcloud's ExApp frame? (LoginPage.jsx's idiom.) */
function isEmbedded() {
    try { return typeof window !== 'undefined' && window.self !== window.top; } catch { return true; }
}

/**
 * Where "Open in {source}" opens. `_top` ONLY when the page is Nextcloud's
 * own — a Tables table, or a file in Nextcloud Files — and the SPA sits in
 * the ExApp frame, where that takes the host to where the person already
 * is. Google Drive and OneDrive are other sites: a `_top` there would
 * replace the whole Nextcloud tab with docs.google.com. They open in a new
 * tab, embedded or not — as the same link on the file card already does.
 */
function sourceTargetOf(table: DetailTable, source: MirrorSource | null | undefined) {
    const ncHosted = isNcMirror(table) || source?.provider === 'nextcloud_files';
    return ncHosted && isEmbedded() ? '_top' : '_blank';
}

export function TableMenu({ t, table, canEdit, mirror = null, isMirror = false, onRename = null, onDuplicate = null, onDelete = null }: TableMenuProps) {
    const [open, setOpen] = useState(false);
    const [health, setHealth] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const anchorRef = useRef<HTMLButtonElement>(null);
    const { copy, copied } = useCopyToClipboard();
    const sourceUrl = mirror ? sourceUrlOf(table, mirror.source) : null;

    const duplicate = async () => {
        setOpen(false);
        setBusy(true);
        setError(null);
        try {
            await onDuplicate?.();
        } catch (e) {
            setError((e as Error)?.message || t('datatables.err_duplicate', 'Could not duplicate the table'));
        } finally {
            setBusy(false);
        }
    };

    const exportCsv = async () => {
        setOpen(false);
        try {
            const text = await datatablesApi.exportCsv(table.id);
            // A Blob and a revoked object URL, NEVER an <a href download>
            // pointing at the API: that link carries no auth header, and on
            // this stack a same-origin download navigates the SPA away from
            // itself (the automations library learned it the hard way).
            const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `${table.key || 'datatable'}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError((e as Error).message || t('datatables.err_export', 'Could not export the rows'));
        }
    };

    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('datatables.table_menu', 'More about this table')}
                className="w-8 h-8 grid place-items-center rounded-lg border focus-visible:outline focus-visible:outline-2"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}
            >
                <Ellipsis className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="right"
                width={260}
                role="menu"
                aria-label={t('datatables.table_menu', 'More about this table')}
                className="py-1"
            >
                {onRename && (
                    <button type="button" role="menuitem" onClick={() => { setOpen(false); onRename(); }}
                        className={MENU_ITEM} style={{ color: 'var(--text-primary)' }} data-testid="menu-rename">
                        <Pencil className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                        {t('datatables.menu_rename', 'Rename table')}
                    </button>
                )}
                {onDuplicate && (
                    <button type="button" role="menuitem" onClick={duplicate} disabled={busy}
                        className={MENU_ITEM} style={{ color: 'var(--text-primary)' }} data-testid="menu-duplicate">
                        <Copy className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                        <span className="min-w-0 flex-1 text-left">
                            <span className="block">{t('datatables.menu_duplicate', 'Duplicate')}</span>
                            <span className="block text-[11px] text-[var(--text-tertiary)]">{t('datatables.menu_duplicate_hint', 'columns only, no rows')}</span>
                        </span>
                    </button>
                )}
                <button type="button" role="menuitem" onClick={exportCsv}
                    className={MENU_ITEM} style={{ color: 'var(--text-primary)' }}>
                    <Download className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    {t('datatables.export_csv_menu', 'Export (CSV)')}
                </button>
                <button type="button" role="menuitem" onClick={() => copy(table.key)}
                    className={MENU_ITEM} style={{ color: 'var(--text-primary)' }}>
                    <Tag className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-left">
                        <span className="block">{t('datatables.field_key', 'Technical name')}</span>
                        <code className="block text-[11px] font-mono truncate text-[var(--text-tertiary)]">{table.key}</code>
                    </span>
                    {copied && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--success)' }} aria-hidden="true" />}
                </button>
                {canEdit && (
                    <button type="button" role="menuitem" onClick={() => { setOpen(false); setHealth(true); }}
                        className={MENU_ITEM} style={{ color: 'var(--text-primary)' }}>
                        <Stethoscope className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                        {t('datatables.check_repair', 'Check & repair')}
                    </button>
                )}
                {sourceUrl && (
                    <a role="menuitem" href={sourceUrl} target={sourceTargetOf(table, mirror?.source)} rel="noopener noreferrer"
                        onClick={() => setOpen(false)} className={MENU_ITEM} style={{ color: 'var(--text-primary)' }}>
                        <ExternalLink className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                        {t('datatables.src_open_in', 'Open in {source}', { source: sourceNameOf(table, mirror?.source) })}
                    </a>
                )}
                {onDelete && (
                    <>
                        <div role="separator" className="my-1 mx-2" style={{ height: 1, background: 'var(--border-default)' }} />
                        <button type="button" role="menuitem" onClick={() => { setOpen(false); onDelete(); }}
                            className={MENU_ITEM} style={{ color: 'var(--error)' }} data-testid="menu-delete">
                            <Trash2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                            {isMirror ? t('datatables.menu_unlink', 'Unlink this table…') : t('datatables.menu_delete', 'Delete this table…')}
                        </button>
                    </>
                )}
            </AnchoredMenu>
            <p aria-live="polite" className="sr-only">{error}</p>
            {health && <HealthDialog t={t} table={table} onClose={() => setHealth(false)} />}
        </>
    );
}

const MENU_ITEM = 'w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-[var(--bg-secondary)] transition';

function HealthDialog({ t, table, onClose }: HealthDialogProps) {
    const [state, setState] = useState<{ loading: boolean; health?: TableHealth; error?: string; repaired?: boolean }>({ loading: true });
    const [busy, setBusy] = useState(false);

    const check = useCallback(async () => {
        setState({ loading: true });
        try {
            setState({ loading: false, health: await datatablesApi.health(table.id) });
        } catch (e) {
            setState({ loading: false, error: (e as Error).message || t('datatables.err_health', 'Could not check this table') });
        }
    }, [table.id, t]);

    useEffect(() => { check(); }, [check]);

    const repair = async () => {
        setBusy(true);
        try {
            const body = await datatablesApi.repair(table.id);
            setState({ loading: false, health: body, repaired: true });
        } catch (e) {
            setState(s => ({ ...s, error: (e as Error).message || t('datatables.err_repair', 'Could not repair this table') }));
        } finally {
            setBusy(false);
        }
    };

    const h = state.health;
    return (
        <Modal open onClose={onClose} size="md" title={t('datatables.check_repair', 'Check & repair')}>
            <div className="space-y-3 text-sm text-[var(--text-secondary)]">
                {state.loading ? (
                    <p className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{t('datatables.loading', 'Loading…')}</p>
                ) : state.error ? (
                    <p className="text-[var(--warning)]">{state.error}</p>
                ) : h?.healthy ? (
                    <p>{state.repaired
                        ? t('datatables.health_repaired', 'Put right — the table and its columns are all there now.')
                        : t('datatables.health_ok', 'Everything matches: the table and every column it should have are there.')}</p>
                ) : (
                    <>
                        <p>
                            {!h?.tableExists
                                ? t('datatables.health_missing_table', 'The storage for this table has not been made yet.')
                                : t('datatables.health_missing_columns', '{n} column(s) are in the model but not in the storage: {keys}.', {
                                    n: (h?.missingColumns || []).length, keys: (h?.missingColumns || []).join(', '),
                                })}
                        </p>
                        <p className="text-xs">
                            {t('datatables.health_repair_blurb', 'Repairing re-runs this table’s own “create if missing” statements. It only ever adds — it cannot drop a column or touch a row.')}
                        </p>
                    </>
                )}
                <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={onClose}
                        className="px-3 py-1.5 rounded-[10px] text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        {t('datatables.close', 'Close')}
                    </button>
                    {!state.loading && h && !h.healthy && (
                        <button type="button" onClick={repair} disabled={busy}
                            className="px-3 py-1.5 rounded-[10px] text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                            {t('datatables.repair', 'Repair it')}
                        </button>
                    )}
                </div>
            </div>
        </Modal>
    );
}
