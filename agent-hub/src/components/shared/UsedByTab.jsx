/**
 * UsedByTab — the ONE "Used by" table, the same on every Studio kind
 * (Bee Flow Builder redesign, Sep 2026, Track 0.4; Studio Home artboard 1b
 * "Tab 'Gebruikt door' · zelfde tabel overal", Agents artboard 1b).
 *
 * A knowledge base, an agent, a skill, a table, a webpage, a meeting note —
 * each can be broken from a screen that is not open in front of you:
 * deleting it, renaming it, tightening its sharing, dropping a column. This
 * tab is the only surface that answers "what would that break", which is
 * why it is always the LAST tab and why the delete dialog shows the same
 * list before it asks for the name.
 *
 * ── THE ROW CONTRACT ────────────────────────────────────────────────
 *   {
 *     kind:      'agent'|'automation'|'app'|'webpage'|'project'|'notebook'
 *                |'chat'|'solution'|'meeting'|'skill'|'datatable'|'kb'|'form',
 *     id:        string,
 *     title:     string | null,       // null ⇒ nothing to show but the kind
 *     role:      'read'|'write'|'readwrite'|'contains'|'invokes'|'chat'
 *                |'ai_step'|'answer_block',
 *     siteLabel?: string,             // "step 6" · "Overview · table view" · "as knowledge"
 *     lastAt?:    ISO string | null,  // a RUN or CONVERSATION time, never an index's updated_at
 *     lastLabel?: string,             // "v1.2" — a version, not a time; overrides lastAt
 *     ownerId?:   string | null,      // drives navigable-vs-plain-text (below)
 *     href?:      string,             // in-app path; derived from kind+id when absent
 *   }
 * `lastLabel` is why the third column is not a bare time formatter: a
 * solution's last touch is a release version.
 *
 * ── THE NAVIGATION RULE (pinned by DatatablesStudio.hygiene.test.jsx) ─
 * Usage is org-wide, but many owners are user-scoped: a colleague's automation
 * has no page this account can open. It used to be a raw <a href>, which on
 * this SPA full-reloads the app and lands on nothing — a link that looks
 * like an answer and is a dead end. So: a row with `ownerId` set to someone
 * else renders as PLAIN TEXT that says whose it is (the person to ask); a
 * row that is yours, or that has no owner (an org-scoped app, an agent),
 * navigates in-app through `onNavigate(href)`.
 *
 * ── LEGACY SHAPES ───────────────────────────────────────────────────
 * The datatables index still answers `{automationId, automationTitle,
 * automationOwner, stepId, mode, columns}`. Pass `adapt` (or the exported
 * `adaptDatatableUsageRow`) and the rows are mapped at render time, so the
 * server and its compatibility tests do not move in this wave.
 *
 * Colours: CSS custom properties only, via kindColors — a kind cannot be
 * blue here and teal on the rail.
 */
import { ArrowUpRight, FolderKanban, Loader2, MessageSquare, NotebookPen } from 'lucide-react';
import React, { useMemo } from 'react';
import { kindColorVar, kindIcon, kindOf, kindTint } from './kindColors';
import useRelativeTime from '../../hooks/useRelativeTime';
import useTranslation from '../../hooks/useTranslation';

export const USAGE_ROLES = Object.freeze([
    'read', 'write', 'readwrite', 'contains', 'invokes', 'chat', 'ai_step', 'answer_block',
]);

/**
 * Kinds that appear in a usage list but are not Studio kinds (kindColors
 * knows the ten things you MAKE; a chat or a project is where a thing is
 * USED). A chat borrows the agent's blue — Agents artboard 1b draws the Chat
 * row with `message-square` in `--type-ai`.
 */
const EXTRA_KIND = Object.freeze({
    chat: { Icon: MessageSquare, color: 'var(--type-ai)' },
    project: { Icon: FolderKanban, color: 'var(--text-secondary)' },
    notebook: { Icon: NotebookPen, color: 'var(--text-secondary)' },
});

/** Studio deep-link segment per kind — only kinds with a detail page. */
const STUDIO_PATH = Object.freeze({
    automation: 'automations',
    agent: 'agents',
    app: 'apps',
    webpage: 'webpages',
    kb: 'knowledge',
    skill: 'skills',
    datatable: 'datatables',
    solution: 'solutions',
});

/** The kind key for a row: a Studio kind via kindOf, else one of the extras. */
export function usageKind(row) {
    const raw = typeof row?.kind === 'string' ? row.kind.trim().toLowerCase() : '';
    if (EXTRA_KIND[raw]) return raw;
    return kindOf(row) || raw || null;
}

function kindVisual(kind) {
    if (EXTRA_KIND[kind]) return EXTRA_KIND[kind];
    return { Icon: kindIcon(kind), color: kindColorVar(kind) };
}

/** `row.href`, else the Studio page for its kind, else null (not navigable). */
export function usageHref(row) {
    if (row?.href) return row.href;
    const segment = STUDIO_PATH[usageKind(row)];
    if (!segment || row?.id == null || row.id === '') return null;
    return `studio/${segment}/${row.id}`;
}

/** Owned by somebody who is not the viewer — the plain-text rule above. */
export function isForeignRow(row, currentUserId) {
    const owner = row?.ownerId;
    if (owner == null || owner === '') return false;
    return owner !== currentUserId;
}

/**
 * The datatables index row → the contract. `mode` is the two-value
 * CHECK(read|write) column; `columns` names what the step touches, which is
 * the part a column drop needs to know, so it rides in `siteLabel`.
 */
export function adaptDatatableUsageRow(u) {
    if (!u || typeof u !== 'object') return null;
    if (u.kind) return u; // already contract-shaped
    const columns = Array.isArray(u.columns) ? u.columns.filter(Boolean) : [];
    return {
        kind: 'automation',
        id: u.automationId,
        title: u.automationTitle || null,
        role: u.mode === 'write' ? 'write' : 'read',
        siteLabel: columns.length ? columns.join(', ') : undefined,
        lastAt: null,
        ownerId: u.automationOwner ?? null,
    };
}

/** Rows through `adapt` (when given), nulls dropped. Pure; safe for tests. */
export function adaptUsageRows(rows, adapt) {
    if (!Array.isArray(rows)) return [];
    const mapped = typeof adapt === 'function' ? rows.map(adapt) : rows;
    return mapped.filter((r) => r && typeof r === 'object');
}

/** `{ kind: count }` in first-seen order, for the summary pills. */
export function countByKind(rows) {
    const counts = new Map();
    for (const row of rows) {
        const kind = usageKind(row) || 'other';
        counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    return [...counts.entries()].map(([kind, n]) => ({ kind, n }));
}

const HEAD_STYLE = {
    display: 'grid',
    gridTemplateColumns: '1fr 120px 120px 32px',
    gap: 12,
    padding: '8px 14px',
    borderBottom: '1px solid var(--border-default)',
    fontSize: 10,
    letterSpacing: '.08em',
    textTransform: 'uppercase',
    fontWeight: 600,
    color: 'var(--text-tertiary)',
};

const ROW_STYLE = {
    display: 'grid',
    gridTemplateColumns: '1fr 120px 120px 32px',
    gap: 12,
    alignItems: 'center',
    padding: '9px 14px',
};

/**
 * @param {object} props
 * @param {Array|null} props.rows          null = not loaded; [] = loaded, nothing
 * @param {boolean}    [props.loading]     explicit loading flag (rows === null also counts)
 * @param {string|null}[props.error]       a failed read — shown above the list, never instead of it
 * @param {string|null}[props.currentUserId]
 * @param {(href: string) => void} [props.onNavigate]
 * @param {string}     [props.roleHeader]  the second column's heading; "Does" by default, an agent says "As"
 * @param {string}     [props.emptyText]
 * @param {(row: any) => object|null} [props.adapt]  legacy row → contract row
 * @param {boolean}    [props.showSummary] the kind pills above the table (default true)
 * @param {string[]}   [props.unchecked]   kinds whose scan did not answer
 *
 * ── AN EMPTY LIST IS A CLAIM, AND `unchecked` IS WHAT WITHDRAWS IT ───
 * "Nothing uses this yet." and the dashed "not used by anything" pill are
 * assertions: everything was looked at and nothing was found. Several usage
 * endpoints cannot make that claim — the webpage one never can, because two of
 * its kinds (`chat`, `agent`) have no row that could answer them — and they say
 * so in `unchecked`. Handed that list, the tab replaces both the sentence and
 * the pill with the narrower ones and names the kinds. Omitting the prop keeps
 * the old wording, so no existing caller changes. An explicit `emptyText` still
 * wins: a caller that has written its own sentence has already thought about
 * this.
 */
export default function UsedByTab({
    rows,
    loading = false,
    error = null,
    currentUserId = null,
    onNavigate = null,
    roleHeader,
    emptyText,
    adapt,
    showSummary = true,
    unchecked = [],
    className = '',
}) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const list = useMemo(() => adaptUsageRows(rows, adapt), [rows, adapt]);
    const pending = loading || rows === null || rows === undefined;

    const kindLabel = (kind, n) => kindLabelFor(t, kind, n);
    const unknownKinds = Array.isArray(unchecked) ? unchecked.filter(Boolean) : [];
    const incomplete = unknownKinds.length > 0;

    if (pending) {
        return (
            <div className={`flex items-center justify-center py-8 ${className}`} data-testid="usage-loading">
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                <span className="sr-only">{t('usage.loading', 'Loading who uses this…')}</span>
            </div>
        );
    }

    return (
        <div className={`flex flex-col gap-3 ${className}`} data-testid="used-by">
            {error && (
                <p className="text-xs" role="status" style={{ color: 'var(--warning)' }}>
                    {t('usage.error', 'Could not load who uses this — the list may be incomplete.')}
                </p>
            )}

            {showSummary && (
                <UsageSummary counts={countByKind(list)} t={t} kindLabel={kindLabel} incomplete={incomplete} />
            )}

            {incomplete && (
                <p className="text-xs" role="status" style={{ color: 'var(--warning)' }} data-testid="usage-unchecked">
                    {t('usage.unchecked_kinds',
                        'Could not be checked: {kinds}. This list is incomplete.',
                        { kinds: unknownKinds.map(k => kindLabel(k, 2)).join(', ') })}
                </p>
            )}

            {list.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }} data-testid="usage-empty">
                    {emptyText || (incomplete
                        ? t('usage.empty_incomplete', 'Nothing was found — but not everything could be checked.')
                        : t('usage.empty', 'Nothing uses this yet.'))}
                </p>
            ) : (
                <div
                    role="table"
                    aria-label={t('usage.table_label', 'Used by')}
                    className="text-xs overflow-hidden"
                    style={{ borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-default)' }}
                >
                    <div role="row" style={HEAD_STYLE}>
                        <span role="columnheader">{t('usage.head_where', 'Where')}</span>
                        <span role="columnheader">{roleHeader || t('usage.head_does', 'Does')}</span>
                        <span role="columnheader">{t('usage.head_last', 'Last time')}</span>
                        <span role="columnheader" aria-label={t('usage.head_open', 'Open')} />
                    </div>
                    {list.map((row, i) => (
                        <UsageRow
                            key={`${usageKind(row)}:${row.id ?? i}:${row.siteLabel ?? ''}`}
                            row={row}
                            last={i === list.length - 1}
                            currentUserId={currentUserId}
                            onNavigate={onNavigate}
                            t={t}
                            rel={rel}
                            kindLabel={kindLabel}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * The kind pills above the table — "3 agents", "1 automation" — or the
 * dashed "not used by anything" when the list is empty (Knowledge/Agents
 * artboards' cards: 14% tint, 999px radius, 10px glyph; the empty pill is
 * dashed `--warning` with the warning ink).
 */
function UsageSummary({ counts, t, kindLabel, incomplete = false }) {
    return (
        <div className="flex flex-wrap gap-1" data-testid="usage-summary">
            {counts.length === 0 ? (
                <span
                    className="inline-flex items-center gap-1 text-xs font-semibold"
                    style={{
                        padding: '1px 7px', borderRadius: 999,
                        border: '1px dashed var(--warning)',
                        color: 'var(--warning-ink, var(--warning))',
                    }}
                >
                    {incomplete
                        ? t('usage.pill_unknown', 'not fully checked')
                        : t('usage.pill_unused', 'not used by anything')}
                </span>
            ) : counts.map(({ kind, n }) => {
                const { Icon, color } = kindVisual(kind);
                return (
                    <span
                        key={kind}
                        className="inline-flex items-center gap-1 text-xs font-semibold"
                        style={{
                            padding: '1px 7px', borderRadius: 999,
                            background: EXTRA_KIND[kind] ? 'var(--bg-tertiary)' : kindTint(kind, 14),
                            color,
                        }}
                    >
                        {Icon && <Icon style={{ width: 10, height: 10 }} aria-hidden="true" />}
                        {t('usage.pill_count', '{n} {kind}', { n, kind: kindLabel(kind, n) })}
                    </span>
                );
            })}
        </div>
    );
}

function UsageRow({ row, last, currentUserId, onNavigate, t, rel, kindLabel }) {
    const kind = usageKind(row);
    const { Icon, color } = kindVisual(kind);
    const href = usageHref(row);
    const foreign = isForeignRow(row, currentUserId);
    const navigable = !foreign && typeof onNavigate === 'function' && !!href;
    const label = kindLabel(kind, 1);
    const title = row.title
        || (foreign
            ? t('usage.someone_elses_kind', 'Someone else’s {kind}', { kind: label })
            : t('usage.untitled_kind', 'Untitled {kind}', { kind: label }));
    const when = row.lastLabel || (row.lastAt ? rel(row.lastAt) : '') || '—';

    return (
        <div
            role="row"
            data-testid="usage-row"
            style={{ ...ROW_STYLE, borderBottom: last ? 'none' : '1px solid var(--border-default)' }}
        >
            <div role="cell" className="flex items-center gap-2 min-w-0">
                {Icon && <Icon style={{ width: 14, height: 14, flexShrink: 0, color }} aria-hidden="true" />}
                {navigable ? (
                    <button
                        type="button"
                        onClick={() => onNavigate(href)}
                        className="font-medium truncate hover:underline rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' }}
                    >
                        {title}
                    </button>
                ) : (
                    <span className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>{title}</span>
                )}
                {row.siteLabel && (
                    <span className="truncate" style={{ color: 'var(--text-tertiary)' }}>· {row.siteLabel}</span>
                )}
                {foreign && row.title && (
                    <span className="shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                        · {t('usage.someone_elses', 'someone else’s')}
                    </span>
                )}
            </div>
            <span role="cell" style={{ color: 'var(--text-secondary)' }}>{roleLabelFor(t, row.role)}</span>
            <span role="cell" style={{ color: 'var(--text-secondary)' }}>{when}</span>
            <span role="cell" className="inline-flex justify-end">
                {navigable && (
                    <ArrowUpRight style={{ width: 13, height: 13, color: 'var(--text-tertiary)' }} aria-hidden="true" />
                )}
            </span>
        </div>
    );
}

/** What the row DOES with this thing — the "Does"/"As" column. */
export function roleLabelFor(t, role) {
    switch (role) {
        case 'read': return t('usage.role_read', 'reads');
        case 'write': return t('usage.role_write', 'writes');
        case 'readwrite': return t('usage.role_readwrite', 'reads and writes');
        case 'contains': return t('usage.role_contains', 'contains');
        case 'invokes': return t('usage.role_invokes', 'invokes');
        case 'chat': return t('usage.role_chat', 'chat partner');
        case 'ai_step': return t('usage.role_ai_step', 'AI step');
        case 'answer_block': return t('usage.role_answer_block', 'answer block');
        default: return role ? String(role) : '';
    }
}

/**
 * Singular/plural noun per kind, for the pills and the untitled fallback.
 * Keys `usage.kind_<kind>` / `usage.kind_<kind>_plural`, English fallbacks
 * inline so the i18n guard can read them.
 */
const KIND_NOUNS = Object.freeze({
    automation: ['automation', 'automations'],
    datatable: ['table', 'tables'],
    app: ['app', 'apps'],
    webpage: ['webpage', 'webpages'],
    form: ['form', 'forms'],
    agent: ['agent', 'agents'],
    skill: ['skill', 'skills'],
    kb: ['knowledge base', 'knowledge bases'],
    meeting: ['meeting note', 'meeting notes'],
    solution: ['solution', 'solutions'],
    chat: ['chat', 'chats'],
    project: ['project', 'projects'],
    notebook: ['notebook', 'notebooks'],
    other: ['item', 'items'],
});

/**
 * A kind this list does not know keeps its OWN name.
 *
 * `unchecked` is an OPEN vocabulary — `KIND_NOUNS` is today's list, not
 * tomorrow's — and mapping an unknown kind onto "items" turns "forms were not
 * checked" into "something unnameable was not checked". The raw token is not
 * pretty, but it names the thing, and it is the signal that a noun is missing
 * here. `other` stays for a row that genuinely has no kind.
 */
export function kindLabelFor(t, kind, n = 1) {
    if (!kind) return n === 1 ? t('usage.kind_other', 'item') : t('usage.kind_other_plural', 'items');
    if (!KIND_NOUNS[kind]) return String(kind);
    const [one, many] = KIND_NOUNS[kind];
    return n === 1
        ? t(`usage.kind_${kind}`, one)
        : t(`usage.kind_${kind}_plural`, many);
}
