import {
    Building2, Check, Copy, Globe, Loader2, Lock, RefreshCw,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Chip } from './WebpageDataCards';
import AudienceRows from '../../components/shared/AudienceRows';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';
import type { TranslateParams } from '../../hooks/useTranslation';
import type { OrgGroup } from '../../components/shared/VisibilityCapsule.types';
import type { WebpageRow } from '../../api/webpagesWebpageRow.types';
import type { ColumnGateTable, ColumnGate, ColumnChoice, AddressOptions, AudienceModel, PublicAiNotesProps, PublicRowProps, ColumnGateFormProps, AddressCardProps, WebpageAudiencePanelProps } from './WebpageAudiencePanel.types';
import { logger } from '../../utils/logger';

const AUDIENCE_URL = (id: string | number | boolean) => `${API_BASE}/api/webpages/${encodeURIComponent(id)}/audience`;
const PUBLIC_URL = (id: string | number | boolean) => `${API_BASE}/api/webpages/${encodeURIComponent(id)}/audience/public`;

async function readJson(res: Response) {
    try { return await res.json(); } catch { return null; }
}

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

/**
 * Which sentence goes beneath the address, about the OTHER external links.
 *
 * "Public off" says something only about the ADDRESS. The server withdraws, on `{on:false}`, exclusively the CANONICAL share; a loose /share/<token> of the same page keeps serving the frozen snapshot afterwards, with the rendered table rows included. If this screen is silent about that, the owner reads "Off" and "Not serving" about a page that is anonymously reachable — precisely the direction that the fourth row must rule out.
 *
 * Four states:
 *   'while_on'  public ON with more than one link: one of them IS the address, the rest stands beside it;
 *   'while_off' public OFF and at least one is still open: none of them is the address, and they keep serving;
 *   'unknown'   public OFF but the share list was unreadable. Then nothing is claimed — 0 from a failed read is not "empty", and precisely here that would make the warning disappear;
 *   'none'      there is nothing to report.
 *
 * With an UNKNOWN public state (`public.known === false`) this sentence stays silent: the row above then already says that the state could not be read, and "Public is off, but…" would add a claim to it that nobody can make good.
 */
export function otherLinksNotice(model: AudienceModel | null | undefined) {
    const known = model?.public?.known !== false;
    const on = !!model?.public?.on;
    const count = Number(model?.shareCount) || 0;
    if (on) return count > 1 ? 'while_on' : 'none';
    if (!known) return 'none';
    if (model?.shareCountKnown === false) return 'unknown';
    return count > 0 ? 'while_off' : 'none';
}

/**
 * The public AI bridge, three-valued — the third property of the public surface, and the only one that is a SWITCH.
 *
 * `aiKnown !== true` means NOT READ, not "off": if that counted as off, the screen would claim "no AI runs publicly" about a field that nobody looked at — the same dangerous direction that `public.known` excludes above. Therefore `runs` hangs on `known` and `grounds` on `runs`: every claim here stands on the reading beneath it.
 */
export function publicAiState(model: AudienceModel | null | undefined) {
    const known = model?.public?.aiKnown === true;
    const runs = known && model?.public?.aiRuns === true;
    return { known, runs, grounds: runs && model?.public?.aiGroundsOnPage === true };
}

function PublicAiNotes({ t, ai }: PublicAiNotesProps) {
    const warn = { color: 'var(--warning)' };
    return (
        <>
            <li data-testid="public-ai" style={ai.known && !ai.runs ? undefined : warn}>
                {!ai.known
                    ? t('webpages.audience.public_ai_unknown',
                        'Whether outside readers can use the AI on this page could not be read, so nothing is claimed about it here.')
                    : ai.runs
                        ? t('webpages.audience.public_ai_on',
                            'Anyone with the address can chat with the AI on this page, and every answer is charged to your AI budget.')
                        : t('webpages.audience.public_ai_off',
                            'Outside readers cannot use the AI on this page, so a public reader can never spend your AI budget.')}
            </li>
            {ai.grounds && (
                <li data-testid="public-ai-grounded" style={warn}>
                    {t('webpages.audience.public_ai_grounded',
                        'Those answers are grounded on this page\'s knowledge, so its sources can reach outside readers without passing the column choice above.')}
                </li>
            )}
            {ai.runs && (
                <li data-testid="public-ai-change">
                    {t('webpages.audience.public_ai_change',
                        'This switch is not on this screen: ask this page\'s AI chat to turn public AI off.')}
                </li>
            )}
        </>
    );
}

// ── de vierde rij ────────────────────────────────────────────────────

function PublicRow({ t, model, busy, onOpen, onTurnOff, disabled }: PublicRowProps) {
    const on = !!model?.public?.on;
    // Three-valued, just like `agent.known` in the column beside it: if the share
    // could not be read, "Off" is a claim about exposure that we cannot make good.
    // Then the row says so, and there is nothing to switch — switching an unknown
    // state on or off is worse than waiting.
    const known = model?.public?.known !== false;
    const ai = publicAiState(model);
    return (
        <Card tone={known ? 'default' : 'warning'}>
            <div className="flex items-center gap-2 flex-wrap">
                <Globe size={14} className="[color:var(--kind-web)]" />
                <span className="text-sm font-medium">{t('webpages.visibility.public', 'Public')}</span>
                {!known
                    ? <Chip label={t('webpages.audience.public_unknown', 'Could not be checked')} tone="muted" dashed />
                    : on
                        ? <Chip label={t('webpages.audience.public_on', 'Anyone with the address')} tone="public" />
                        : <Chip label={t('common.off', 'Off')} tone="muted" dashed />}
                <span className="flex-1" />
                {known && on && (
                    <button
                        type="button"
                        data-testid="public-columns"
                        disabled={disabled || busy}
                        onClick={onOpen}
                        className="text-xs underline disabled:opacity-50"
                    >
                        {t('webpages.audience.change_columns', 'Change what goes out')}
                    </button>
                )}
                {known && (
                    <button
                        type="button"
                        data-testid="public-toggle"
                        disabled={disabled || busy}
                        onClick={on ? onTurnOff : onOpen}
                        className="text-xs underline disabled:opacity-50 inline-flex items-center gap-1"
                    >
                        {busy && <Loader2 size={12} className="animate-spin" />}
                        {on
                            ? t('webpages.audience.turn_off', 'Turn off')
                            : t('webpages.audience.turn_on', 'Make public')}
                    </button>
                )}
            </div>
            {!known && (
                <p className="text-sm">
                    {t('webpages.audience.public_unknown_body',
                        'Whether this page is public right now could not be read, so nothing is claimed here and nothing can be changed until it can.')}
                </p>
            )}
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('webpages.audience.public_body',
                    'A public page is a snapshot without scripts, not the live page. It updates when you save, and when a table it shows changes.')}
            </p>
            <ul className="text-[11px] list-disc pl-4 text-[var(--text-secondary)]">
                <li>{t('webpages.audience.public_tables_read_only',
                    'Table blocks are read-only here. Writing back to a table is only possible for Personal, Entire organisation and Groups.')}</li>
                {/* The tail of this sentence ("stays empty") is precisely FALSE as soon as public
                    AI is on: the Agent block indeed does not run there, but the bare chat
                    does answer. That is why the ternary is around the KEY and not around
                    a half sentence. */}
                <li>{ai.runs
                    ? t('webpages.audience.public_agent_never_ai_on',
                        'An agent block never runs on a public share. The plain AI chat below is a different thing, and it does answer outside readers.')
                    : t('webpages.audience.public_agent_never',
                        'An agent block never runs on a public share, so a chat block on this page stays blank for outside readers.')}</li>
                {/* De derde eigenschap: de enige die geld kost, en de enige die
                    een anonieme bezoeker een levend kanaal geeft. */}
                <PublicAiNotes t={t} ai={ai} />
            </ul>
        </Card>
    );
}

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

function AddressCard({ t, model, options, setOptions, onSaveOptions, busy }: AddressCardProps) {
    const [copied, setCopied] = useState(false);
    const [open, setOpen] = useState(false);
    const address = model?.address;
    const isPublic = !!model?.public?.on;
    // What must be said about the OTHER external links — the line stands apart and
    // pure, because it depends on three fields and is the only thing that keeps
    // "Not serving" from being read as "nobody can get at it any more".
    const notice = otherLinksNotice(model);

    const copy = async () => {
        const value = address?.url || address?.path || '';
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch (err) { logger.debug('een browser zonder klembord: de tekst staat er gewoon', err); }
    };

    return (
        <Card>
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">{t('webpages.address.title', 'Address')}</span>
                {isPublic
                    ? <Chip label={t('webpages.address.live', 'Live')} tone="public" />
                    : <Chip label={t('webpages.address.not_serving', 'Not serving')} tone="muted" dashed />}
            </div>

            {address ? (
                <div className="flex items-center gap-2 flex-wrap">
                    <code
                        data-testid="address-value"
                        className="text-[11px] px-1.5 py-0.5 rounded border border-[var(--border-subtle)] text-[var(--text-primary)]"
                    >
                        {address.url || address.path}
                    </code>
                    <button type="button" onClick={copy} className="text-xs underline inline-flex items-center gap-1">
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? t('webpages.address.copied', 'Copied') : t('common.copy', 'Copy')}
                    </button>
                </div>
            ) : (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.address.none_yet', 'This page gets its address the first time you make it public.')}
                </p>
            )}

            {address && (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.address.made_of',
                        'The readable part comes from the page name as it was the first time you made this page public, and the rest is random so the address cannot be guessed. Renaming the page does not move it.')}
                </p>
            )}

            {address && !isPublic && (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.address.kept_while_off',
                        'The address stays reserved while Public is off — it shows nothing until you turn Public back on, and then it is the same link again.')}
                </p>
            )}

            <button
                type="button"
                data-testid="address-options-toggle"
                onClick={() => setOpen(o => !o)}
                className="self-start text-xs underline"
                aria-expanded={open}
            >
                {t('webpages.all_options', 'All options')}
            </button>

            {open && (
                <div className="flex flex-col gap-2 pt-1 border-t border-[var(--border-subtle)]">
                    <fieldset className="flex flex-col gap-1">
                        <legend className="text-[11px] font-medium">
                            {t('webpages.address.who_may_open', 'Who may open the address')}
                        </legend>
                        {[
                            ['unlisted', t('webpages.address.mode_unlisted', 'Anyone with the address')],
                            ['password', t('webpages.address.mode_password', 'Anyone with the address and the password')],
                            ['email', t('webpages.address.mode_email', 'Only these email addresses')],
                        ].map(([value, label]) => (
                            <label key={value} className="inline-flex items-center gap-2 text-[11px] cursor-pointer">
                                <input
                                    type="radio"
                                    name="bf-access-mode"
                                    value={value}
                                    checked={options.accessMode === value}
                                    onChange={() => setOptions(o => ({ ...o, accessMode: value }))}
                                />
                                {label}
                            </label>
                        ))}
                    </fieldset>

                    {options.accessMode === 'password' && (
                        <label className="flex flex-col gap-1 text-[11px]">
                            {t('webpages.address.password', 'Password (at least 6 characters)')}
                            <input
                                type="password"
                                value={options.password}
                                onChange={(e) => setOptions(o => ({ ...o, password: e.target.value }))}
                                className="rounded border px-2 py-1 [border-color:var(--border-subtle)] [background:var(--bg-primary)]"
                            />
                        </label>
                    )}

                    {options.accessMode === 'email' && (
                        <label className="flex flex-col gap-1 text-[11px]">
                            {t('webpages.address.emails', 'Email addresses, one per line')}
                            <textarea
                                rows={3}
                                value={options.emails}
                                onChange={(e) => setOptions(o => ({ ...o, emails: e.target.value }))}
                                className="rounded border px-2 py-1 [border-color:var(--border-subtle)] [background:var(--bg-primary)]"
                            />
                        </label>
                    )}

                    <label className="flex flex-col gap-1 text-[11px]">
                        {t('webpages.address.expires', 'Stops working on')}
                        <input
                            type="date"
                            value={options.expiresAt}
                            onChange={(e) => setOptions(o => ({ ...o, expiresAt: e.target.value }))}
                            className="rounded border px-2 py-1 self-start [border-color:var(--border-subtle)] [background:var(--bg-primary)]"
                        />
                    </label>

                    <p className="text-[11px] text-[var(--text-secondary)]">
                        {t('webpages.address.replace_warning',
                            'Changing the password or the email list replaces the underlying link, so links people already have stop working. The address itself stays the same.')}
                    </p>

                    {isPublic && (
                        <button
                            type="button"
                            data-testid="address-options-save"
                            disabled={busy}
                            onClick={onSaveOptions}
                            className="self-start text-xs underline disabled:opacity-50 inline-flex items-center gap-1"
                        >
                            {busy && <Loader2 size={12} className="animate-spin" />}
                            {t('webpages.address.save_options', 'Apply')}
                        </button>
                    )}
                </div>
            )}

            {/* While Public is ON: only with more than one, because then one of those links
                is the address and the rest stands beside it. The sentence is therefore
                always plural and needs no singular form. */}
            {notice === 'while_on' && (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.address.other_links',
                        'There are {n} external links on this page in total. Only this one is the address; the others are separate share links.')
                        .replace('{n}', String(model.shareCount))}
                </p>
            )}

            {/* If Public is OFF, that threshold no longer applies: none of the remaining links
                is the address any more, and they all keep serving. One link is then
                precisely the case that MUST be reported. */}
            {notice === 'while_off' && (
                <p
                    data-testid="other-links-while-off"
                    className="text-[11px] text-[var(--warning)]"
                >
                    {model.shareCount === 1
                        ? t('webpages.address.serving_while_off',
                            'Public is off, but one external link still serves a snapshot of this page. It is not the address, so turning Public off did not stop it.')
                        : t('webpages.address.serving_while_off_plural',
                            'Public is off, but {n} external links still serve a snapshot of this page. They are not the address, so turning Public off did not stop them.')
                            .replace('{n}', String(model.shareCount))}
                </p>
            )}

            {notice === 'unknown' && (
                <p
                    data-testid="other-links-unknown"
                    className="text-[11px] text-[var(--warning)]"
                >
                    {t('webpages.address.other_links_unknown',
                        'Whether other external links still serve this page could not be checked, so nothing is claimed here.')}
                </p>
            )}

            {model?.solution && (
                <p className="text-[11px] pt-1 border-t text-[var(--text-secondary)] border-[var(--border-subtle)]">
                    <Building2 size={11} className="inline mr-1" aria-hidden="true" />
                    {t('webpages.address.part_of_solution', 'Part of solution {name}').replace('{name}', model.solution.name)}
                </p>
            )}
        </Card>
    );
}

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
    const [state, setState] = useState<{ loading: boolean; error: string | null; data: AudienceModel | null }>({ loading: true, error: null, data: null });
    const [gateOpen, setGateOpen] = useState(false);
    const [choice, setChoice] = useState<ColumnChoice>({});
    const [busy, setBusy] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [options, setOptions] = useState<AddressOptions>({ accessMode: 'unlisted', password: '', emails: '', expiresAt: '' });

    /**
     * Take over the server model as local state.
     *
     * `choice` belongs here, and that is not cosmetic: `publishBody` always sends
     * `choice` along, and the server reads a missing table as ZERO columns. Were
     * `choice` to stay empty because the user had not opened the column choice, then
     * "Apply" under All options would shut the entire gate without anyone having asked
     * for that. So: after every read and after every write, the ACTUAL state stands here.
     */
    const adopt = useCallback((body: AudienceModel | null) => {
        setState({ loading: false, error: null, data: body });
        setChoice(initialColumnChoice(body?.columnGate, !!body?.public?.on));
        setOptions({
            accessMode: body?.public?.accessMode || 'unlisted',
            password: '',
            emails: (body?.public?.allowedEmails || []).join('\n'),
            expiresAt: body?.public?.expiresAt ? String(body.public.expiresAt).slice(0, 10) : '',
        });
    }, []);

    const load = useCallback(async () => {
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const res = await authFetch(AUDIENCE_URL(webpageId));
            const body = await readJson(res);
            if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
            adopt(body);
        } catch (e) {
            setState({ loading: false, error: (e as Error).message || 'failed', data: null });
        }
    }, [webpageId, adopt]);

    useEffect(() => { if (webpageId && !readOnly) load(); }, [webpageId, readOnly, load]);

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
            const res = await authFetch(PUBLIC_URL(webpageId), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const out = await readJson(res);
            if (!res.ok) throw new Error((out && out.error) || `HTTP ${res.status}`);
            adopt(out);
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
