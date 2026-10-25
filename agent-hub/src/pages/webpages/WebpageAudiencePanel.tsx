import { Loader2, Lock, RefreshCw } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { Card } from './WebpageDataCards';
import AudienceRows from '../../components/shared/AudienceRows';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE } from '../../utils/helpers';
import { useWebpageAudienceQuery } from '../../api/queries/webpagesPanels';
import { mutate, RefusedError, errorBody } from '../../api/mutate';
import type { TranslateParams } from '../../hooks/useTranslation';
import type { OrgGroup } from '../../components/shared/VisibilityCapsule.types';
import type { WebpageRow } from '../../api/webpagesWebpageRow.types';
import type { ColumnGateTable, ColumnGate, ColumnChoice, AddressOptions, AudienceModel, ColumnGateFormProps, WebpageAudiencePanelProps } from './WebpageAudiencePanel.types';
import { AddressCard } from './AddressCard';
import { PublicRow } from './PublicRow';
;
;

const PUBLIC_URL = (id: string | number | boolean) => `${API_BASE}/api/webpages/${encodeURIComponent(id)}/audience/public`;

/**
 * The column choice with which the form OPENS.
 *
 * Already public → the current state, because that is a fact and not an assumption. Not yet public → empty, for every table. Pre-ticking would turn the question "which columns may go outside" into a "consent" that nobody read. Pure and exported, because this is the only place where that rule lives.
 */
export function initialColumnChoice(columnGate: ColumnGate | null | undefined, isPublic: boolean) {
    const out: ColumnChoice = {};
    for (const t of (columnGate?.tables || [])) {
        out[t.datatableId] = isPublic && Array.isArray(t.publicColumns) ? [...t.publicColumns] : [];
    }
    return out;
}

/** How many columns would go outside in total with this choice. */
export function countChosenColumns(choice: ColumnChoice | null | undefined) {
    return Object.values(choice || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}

/**
 * How many columns go outside TODAY, according to the server.
 *
 * Deliberately columns and not tables: "1 of 1 bound tables" is not a sentence, and moreover the number of COLUMNS is the number that matters — that is what is on the public page.
 */
export function countPublicColumns(columnGate: ColumnGate | null | undefined) {
    return (columnGate?.tables || []).reduce(
        (n, t) => n + (Array.isArray(t.publicColumns) ? t.publicColumns.length : 0), 0);
}

// ── de vierde rij ────────────────────────────────────────────────────

// ── de kolompoort ────────────────────────────────────────────────────

function ColumnGateForm({ t, columnGate, choice, setChoice, onConfirm, onCancel, busy }: ColumnGateFormProps) {
    const tables = columnGate?.tables || [];
    const toggle = (tableId: string, key: string) => {
        setChoice(prev => {
            const cur = Array.isArray(prev[tableId]) ? prev[tableId] : [];
            const next = cur.includes(key) ? cur.filter(c => c !== key) : [...cur, key];
            return { ...prev, [tableId]: next };
        });
    };
    const chosen = countChosenColumns(choice);
    return (
        <Card tone="warning">
            <div className="text-sm font-medium">
                {t('webpages.audience.gate_title', 'What may leave this page?')}
            </div>
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('webpages.audience.gate_body',
                    'Tick the columns that may appear on the public page. Anything you leave unticked stays inside — there is no "everything" here on purpose.')}
            </p>
            {tables.map(tb => (
                <div key={tb.datatableId} className="flex flex-col gap-1" data-testid={`gate-table-${tb.datatableId}`}>
                    <div className="text-[11px] font-medium">{tb.label || tb.datatableId}</div>
                    <div className="flex flex-wrap gap-2">
                        {(tb.columns || []).length === 0 && (
                            <span className="text-[11px] text-[var(--text-secondary)]">
                                {t('webpages.audience.gate_no_columns', 'This binding reads no columns, so nothing can go out.')}
                            </span>
                        )}
                        {(tb.columns || []).map(key => {
                            const ticked = (choice[tb.datatableId] || []).includes(key);
                            return (
                                <label key={key} className="inline-flex items-center gap-1 text-[11px] cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={ticked}
                                        onChange={() => toggle(tb.datatableId, key)}
                                        aria-label={key}
                                    />
                                    {key}
                                </label>
                            );
                        })}
                    </div>
                </div>
            ))}
            <div className="flex items-center gap-3 pt-1">
                <button
                    type="button"
                    data-testid="gate-confirm"
                    disabled={busy}
                    onClick={onConfirm}
                    className="text-xs underline disabled:opacity-50 inline-flex items-center gap-1"
                >
                    {busy && <Loader2 size={12} className="animate-spin" />}
                    {t('webpages.audience.gate_confirm', 'Make public')}
                </button>
                <button type="button" onClick={onCancel} disabled={busy} className="text-xs underline disabled:opacity-50">
                    {t('common.cancel', 'Cancel')}
                </button>
                <span className="text-[11px] text-[var(--text-secondary)]">
                    {chosen === 0
                        ? t('webpages.audience.gate_none_chosen', 'Nothing from your tables goes out.')
                        : chosen === 1
                            ? t('webpages.audience.gate_n_chosen', 'One column goes out.')
                            : t('webpages.audience.gate_n_chosen_plural', '{n} columns go out.').replace('{n}', String(chosen))}
                </span>
            </div>
        </Card>
    );
}

// ── het adres ────────────────────────────────────────────────────────

// ── het paneel ───────────────────────────────────────────────────────

export default function WebpageAudiencePanel({
    webpageId,
    page = null,
    orgGroups = [],
    readOnly = false,
    onSetPersonal = null,
    onSetEntireOrg = null,
    onToggleGroup = null,
}: WebpageAudiencePanelProps) {
    const { t } = useTranslation();
    const audienceQuery = useWebpageAudienceQuery<AudienceModel>(webpageId, !readOnly);
    // The model a save answered with replaces the read until the next read ("Try again" drops it).
    const [saved, setSaved] = useState<AudienceModel | null>(null);
    const [gateOpen, setGateOpen] = useState(false);
    const [choice, setChoice] = useState<ColumnChoice>({});
    const [busy, setBusy] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [options, setOptions] = useState<AddressOptions>({ accessMode: 'unlisted', password: '', emails: '', expiresAt: '' });
    const state = {
        loading: audienceQuery.isPending || audienceQuery.isFetching,
        error: audienceQuery.isError ? (audienceQuery.error.message || 'failed') : null,
        data: saved ?? audienceQuery.data ?? null,
    };

    /**
     * Take over the server model as local state: whenever the model changes (a read or a save
     * answered), the column choice and the address options restart from it.
     *
     * `choice` belongs here, and that is not cosmetic: `publishBody` always sends
     * `choice` along, and the server reads a missing table as ZERO columns. Were
     * `choice` to stay empty because the user had not opened the column choice, then
     * "Apply" under All options would shut the entire gate without anyone having asked
     * for that. So: after every read and after every write, the ACTUAL state stands here.
     */
    const [adoptedFrom, setAdoptedFrom] = useState<AudienceModel | null>(null);
    if (state.data && state.data !== adoptedFrom) {
        const body = state.data;
        setAdoptedFrom(body);
        setChoice(initialColumnChoice(body.columnGate, !!body.public?.on));
        setOptions({
            accessMode: body.public?.accessMode || 'unlisted',
            password: '',
            emails: (body.public?.allowedEmails || []).join('\n'),
            expiresAt: body.public?.expiresAt ? String(body.public.expiresAt).slice(0, 10) : '',
        });
    }

    const load = () => { setSaved(null); void audienceQuery.refetch(); };

    const model = state.data;
    const boundTables = useMemo(() => (model?.columnGate?.tables || []), [model]);
    const publicColumnCount = useMemo(() => countPublicColumns(model?.columnGate), [model]);

    /** The body of PUT /audience/public — one place, so that enabling and adjusting do not diverge. */
    const publishBody = (on: boolean) => ({
        on,
        publicColumns: choice,
        accessMode: options.accessMode,
        ...(options.password ? { password: options.password } : {}),
        allowedEmails: options.emails.split('\n').map(s => s.trim()).filter(Boolean),
        expiresAt: options.expiresAt || null,
    });

    const send = async (body: unknown) => {
        setBusy(true);
        setSaveError(null);
        try {
            let out: AudienceModel | null;
            try {
                const res = await mutate(PUBLIC_URL(webpageId), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                try { out = await res.json(); } catch { out = null; }
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                throw new Error((errorBody(err) as { error?: string } | null)?.error || `HTTP ${err.status}`);
            }
            setSaved(out);
            setGateOpen(false);
        } catch (e) {
            setSaveError((e as Error).message || 'failed');
        } finally {
            setBusy(false);
        }
    };

    const openGate = () => {
        const start = initialColumnChoice(model?.columnGate, !!model?.public?.on);
        setChoice(start);
        // No bound tables = nothing to ask. The choice then becomes an empty map, and
        // that is precisely what the server reads as "nothing outside".
        if (boundTables.length === 0) {
            send({ ...publishBody(true), publicColumns: {} });
            return;
        }
        setGateOpen(true);
    };

    if (readOnly) {
        return (
            <div className="p-4 text-sm text-[var(--text-secondary)]">
                {t('webpages.audience.owner_only', 'Only the page owner can change who can see this page.')}
            </div>
        );
    }

    return (
        <div className="p-3 flex flex-col gap-3">
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('webpages.audience.subtitle', 'Who can see this page, and where it lives.')}
            </p>

            <AudienceRows
                t={t}
                agent={page}
                confirmWidening
                isPublished={!!page?.isPublished}
                sharedGroups={Array.isArray(page?.sharedGroups) ? page.sharedGroups : []}
                orgGroups={orgGroups}
                onSetPersonal={onSetPersonal}
                onSetEntireOrg={onSetEntireOrg}
                onToggleGroup={onToggleGroup}
                disabled={!onSetPersonal}
                hint={t('webpages.audience.inside_hint',
                    'Inside Bee Flow, readers see the version you published — not what you are editing right now.')}
            />

            {state.loading && (
                <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                    <Loader2 size={14} className="animate-spin" />
                    {t('webpages.audience.loading', 'Reading who can see this page…')}
                </div>
            )}

            {!state.loading && state.error && (
                <Card tone="warning">
                    <p className="text-sm">{t('webpages.audience.load_failed', 'Could not load who can see this page.')}</p>
                    <button type="button" className="self-start text-xs underline inline-flex items-center gap-1" onClick={load}>
                        <RefreshCw size={12} /> {t('webpages.retry', 'Try again')}
                    </button>
                </Card>
            )}

            {!state.loading && !state.error && model && (
                <>
                    <PublicRow
                        t={t}
                        model={model}
                        busy={busy && !gateOpen}
                        disabled={gateOpen}
                        onOpen={openGate}
                        onTurnOff={() => send({ on: false })}
                    />

                    {gateOpen && (
                        <ColumnGateForm
                            t={t}
                            columnGate={model.columnGate}
                            choice={choice}
                            setChoice={setChoice}
                            busy={busy}
                            onConfirm={() => send(publishBody(true))}
                            onCancel={() => setGateOpen(false)}
                        />
                    )}

                    {saveError && (
                        <Card tone="warning">
                            <p className="text-sm" data-testid="audience-save-error">{saveError}</p>
                        </Card>
                    )}

                    <AddressCard
                        t={t}
                        model={model}
                        options={options}
                        setOptions={setOptions}
                        busy={busy}
                        onSaveOptions={() => send(publishBody(true))}
                    />

                    {/* What actually goes outside today — the gate in one sentence, even when it is closed. */}
                    <p className="text-[11px] text-[var(--text-secondary)]">
                        <Lock size={11} className="inline mr-1" aria-hidden="true" />
                        {!model.columnGate?.anyBound
                            ? t('webpages.audience.gate_no_tables', 'No tables are bound to this page, so no rows go out.')
                            : publicColumnCount === 0
                                ? t('webpages.audience.gate_summary_none', 'No column from a bound table appears on the public page.')
                                : publicColumnCount === 1
                                    ? t('webpages.audience.gate_summary', 'One column from a bound table appears on the public page.')
                                    : t('webpages.audience.gate_summary_plural', '{n} columns from bound tables appear on the public page.')
                                        .replace('{n}', String(publicColumnCount))}
                    </p>
                </>
            )}
        </div>
    );
}
