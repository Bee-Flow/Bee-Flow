import { Check, ChevronDown, Loader2, Table } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import AnchoredMenu from '../../components/shared/AnchoredMenu';
import { kindColorVar, kindIcon } from '../../components/shared/kindColors';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';

/**
 * "Pick a source ▾" — the table / automation chooser in the overview's build
 * bar (Webpages artboard 1a, plan W1).
 *
 * A source is what the page READS or STARTS, and naming it up front is what
 * turns "build me a status page" into a page that is wired to something. The
 * server verifies every id again on `POST /api/webpages` (a table must grade
 * at least viewer, an automation must be the caller's own), so this list is a
 * convenience, never the authorisation.
 *
 * It fetches its two lists ON FIRST OPEN and keeps them: the overview is the
 * first screen of the section and must not pay for two more requests before
 * anyone has decided to build anything.
 *
 * `value` / `onChange` are `[{ kind: 'datatable' | 'automation', id, name }]`
 * — exactly the `sources` array the create endpoint takes.
 */
export default function SourcePicker({ value = [], onChange, disabled = false }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [tables, setTables] = useState(null);
    const [automations, setAutomations] = useState(null);
    const anchorRef = useRef(null);
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const load = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const [tRes, aRes] = await Promise.all([
                authFetch(`${API_BASE}/api/datatables`),
                authFetch(`${API_BASE}/api/automation/`),
            ]);
            const tBody = tRes.ok ? await tRes.json() : null;
            const aBody = aRes.ok ? await aRes.json() : null;
            if (!alive.current) return;
            // One list failing is not the other list's problem — a user with no
            // datatables licence still has automations to pick.
            setTables(Array.isArray(tBody?.datatables) ? tBody.datatables : []);
            setAutomations(Array.isArray(aBody?.automations) ? aBody.automations : []);
            if (!tRes.ok && !aRes.ok) setError(true);
        } catch {
            if (alive.current) setError(true);
        } finally {
            if (alive.current) setLoading(false);
        }
    }, []);

    const toggleOpen = () => {
        const next = !open;
        setOpen(next);
        if (next && tables === null && automations === null && !loading) load();
    };

    const isPicked = (kind, id) => value.some(s => s.kind === kind && s.id === id);
    const toggle = (kind, id, name) => {
        if (isPicked(kind, id)) onChange?.(value.filter(s => !(s.kind === kind && s.id === id)));
        else onChange?.([...value, { kind, id, name }]);
    };

    const count = value.length;

    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={toggleOpen}
                disabled={disabled}
                aria-haspopup="menu"
                aria-expanded={open}
                data-testid="webpages-source-picker"
                className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs transition-colors hover:bg-[var(--bg-secondary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                style={{
                    padding: '6px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-secondary)',
                    background: 'transparent',
                }}
            >
                <Table size={13} aria-hidden="true" style={{ color: kindColorVar('datatable') }} />
                {t('webpages.build.pick_source', 'Pick a source')}
                {count > 0 && <span className="tabular-nums" style={{ color: 'var(--text-primary)' }}>{count}</span>}
                <ChevronDown size={12} aria-hidden="true" className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </button>

            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="left"
                width={280}
                role="menu"
                aria-label={t('webpages.build.pick_source', 'Pick a source')}
                className="py-1"
            >
                <PickerBody
                    t={t}
                    loading={loading}
                    error={error}
                    tables={tables}
                    automations={automations}
                    isPicked={isPicked}
                    onToggle={toggle}
                />
            </AnchoredMenu>
        </>
    );
}

/** Loading / failed / the two groups — kept out of the trigger's own render. */
function PickerBody({ t, loading, error, tables, automations, isPicked, onToggle }) {
    if (loading) {
        return (
            <div className="px-3 py-2 text-xs flex items-center gap-2" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                {t('webpages.sources.loading', 'Loading…')}
            </div>
        );
    }
    if (error) {
        return (
            <div className="px-3 py-2 text-xs" style={{ color: 'var(--error-ink)' }} role="alert">
                {t('webpages.sources.error', 'Could not load your tables and automations.')}
            </div>
        );
    }
    const tableItems = (tables || []).map(x => ({ id: x.id, name: x.name || x.key || x.id }));
    const automationItems = (automations || []).map(x => ({ id: x.id, name: x.title || x.id }));
    if (!tableItems.length && !automationItems.length) {
        return (
            <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('webpages.sources.empty', 'No tables or automations to pick yet.')}
            </div>
        );
    }
    return (
        <>
            <Group
                label={t('webpages.sources.tables', 'Tables')}
                kind="datatable"
                items={tableItems}
                isPicked={isPicked}
                onToggle={onToggle}
            />
            <Group
                label={t('webpages.sources.automations', 'Automations')}
                kind="automation"
                items={automationItems}
                isPicked={isPicked}
                onToggle={onToggle}
            />
        </>
    );
}

/** One kind's rows. The glyph is the kind's own — kindColors, never a choice. */
function Group({ label, kind, items, isPicked, onToggle }) {
    if (!items.length) return null;
    const Icon = kindIcon(kind);
    return (
        <>
            <div
                className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide"
                style={{ color: 'var(--text-tertiary)' }}
            >
                {label}
            </div>
            {items.map(item => {
                const picked = isPicked(kind, item.id);
                return (
                    <button
                        key={`${kind}:${item.id}`}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={picked}
                        onClick={() => onToggle(kind, item.id, item.name)}
                        className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition hover:bg-[var(--bg-secondary)]"
                        style={{ color: picked ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                    >
                        <Check size={13} aria-hidden="true" className={picked ? 'opacity-100' : 'opacity-0'} />
                        <Icon size={13} aria-hidden="true" style={{ color: kindColorVar(kind) }} />
                        <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    </button>
                );
            })}
        </>
    );
}
