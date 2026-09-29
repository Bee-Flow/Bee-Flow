import { AlertTriangle, Building2, ChevronRight, Loader2, Lock, Timer, User, Users, Workflow } from 'lucide-react';
import React from 'react';
import { audienceOf, GRADE_LABEL, GROUPS, ORG, isSourceMirror, sourceNameOf, tableKindOf } from './datatableDisplay';
import { sourceGlyphOf } from './sourceGlyphs';
import { kindIcon, kindTileStyle } from '../../../shared/kindColors';

/**
 * One table in the list (Datatables artboard 1b).
 *
 * A card, not a row of text, because four different questions get asked of
 * this list and three of them used to need opening the table to answer:
 * what KIND of table is it, how many rows does it hold, is anything actually
 * using it, and who else can see it. The card answers all four in one line
 * of meta, in that order.
 *
 * It stays ONE <button>. A card with a link inside a link is a keyboard trap
 * and a screen-reader riddle; the chevron is decoration on the button, not a
 * second target.
 *
 * ── THREE WORDS THAT ARE NOT INTERCHANGEABLE ─────────────────────────
 *   scope     — the organisation, or this account alone. A tenancy, decided
 *               at creation and never changed afterwards.
 *   audience  — who a shared ORGANISATION table is published to. A setting.
 *   grade     — what YOU may do with it.
 * All three ride the card because each answers a different person's
 * question, and collapsing them is what made "Private" read as "nobody else
 * has this" over a table the whole company could read. A personal table
 * therefore says "Personal", never "Private": there is no sharing to have.
 */
export default function DatatableCard({ t, table, onOpen }) {
    const personal = table.scopeKind === 'user';
    const kind = tableKindOf(table);
    const { tile, glyph } = kindTileStyle(kind, { size: 36, pct: 16 });
    // A mirror — of a Nextcloud table, or of a sheet in a spreadsheet file —
    // IS a datatable (same colour, same place) but wears its source's glyph,
    // so a list of twenty says at a glance which ones are really somebody
    // else's. The list payload ships `source`, so the chip can name it.
    const mirror = isSourceMirror(table);
    const glyphType = sourceGlyphOf(table) || kindIcon(kind);
    const audience = audienceOf(table);
    const AudienceIcon = personal ? User : (audience === ORG || audience === GROUPS) ? Users : Lock;

    const audienceLabel = personal ? t('datatables.audience_personal', 'Personal')
        : audience === ORG ? t('datatables.audience_org', 'Whole organisation')
            : audience === GROUPS ? t('datatables.audience_groups', 'Shared with groups')
                : t('datatables.audience_private', 'Private');

    return (
        <li>
            <button
                type="button"
                onClick={onOpen}
                className="w-full text-left grid items-center gap-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                    gridTemplateColumns: '36px minmax(0,1fr) auto',
                    padding: '14px 16px',
                    borderRadius: 12,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-default)',
                    boxShadow: 'var(--shadow-sm)',
                    outlineColor: 'var(--accent-primary)',
                }}
            >
                <span style={tile} aria-hidden="true">{glyphType ? React.createElement(glyphType, { style: glyph }) : null}</span>

                <span className="min-w-0">
                    <span className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{table.name}</span>
                        <Chip>
                            {table.managedKind === 'http_cache'
                                ? t('datatables.kindchip_http_cache', 'answers from a web service')
                                : table.managedKind === 'form_answers'
                                    ? t('datatables.frm_kindchip', 'answers from a form')
                                    : mirror
                                    ? t('datatables.src_chip_from', 'from {source}', { source: sourceNameOf(table) })
                                    : t('datatables.kindchip_plain', 'ordinary table')}
                        </Chip>
                        {mirror && <SyncChip t={t} sync={table.sync} />}
                        {/* `!!` because a bare && on a number renders the number. */}
                        {!!table.retentionDays && (
                            <Chip tone="warning">
                                <Timer className="w-3 h-3" aria-hidden="true" />
                                {t('datatables.chip_retention', 'kept {n} days', { n: table.retentionDays })}
                            </Chip>
                        )}
                    </span>
                    <span className="block text-xs mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>
                        {table.description || t('datatables.no_description', 'No description')}
                        <span style={{ color: 'var(--text-tertiary)' }}>{' · '}{gradeText(t, table.grade)}</span>
                    </span>
                </span>

                <span className="flex items-center gap-3.5 text-xs whitespace-nowrap"
                    style={{ color: 'var(--text-secondary)' }}>
                    <span>{rowsText(t, table.rowCount)}</span>
                    <UsagePill t={t} count={table.usageCount} />
                    <span className="inline-flex items-center gap-1.5">
                        {personal
                            ? <User className="w-3 h-3" aria-hidden="true" />
                            : <Building2 className="w-3 h-3" aria-hidden="true" />}
                        {personal
                            ? t('datatables.scope_word_personal', 'only this account')
                            : t('datatables.scope_word_org', 'organisation')}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <AudienceIcon className="w-3 h-3" aria-hidden="true" />
                        {audienceLabel}
                    </span>
                    <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                </span>
            </button>
        </li>
    );
}

/**
 * How the last refresh from the source went — only when there is something
 * to say. "Up to date" is what the cloud already means; a failure, a pass
 * that is running, and a copy the cap cut short are the three things a
 * person scanning the list should not have to open the table to learn.
 */
function SyncChip({ t, sync }) {
    if (!sync) return null;
    if (sync.status === 'running') {
        return (
            <Chip>
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                {t('datatables.nc_chip_running', 'refreshing…')}
            </Chip>
        );
    }
    if (sync.status === 'error') {
        return (
            <Chip tone="warning" title={sync.lastError || undefined}>
                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                {t('datatables.nc_chip_error', 'refresh failed')}
            </Chip>
        );
    }
    if (sync.truncated) {
        return (
            <Chip tone="warning">
                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                {t('datatables.nc_chip_truncated', 'not every row')}
            </Chip>
        );
    }
    return null;
}

/** "1,284 rows" — grouped, because four digits without a separator read as a year. */
function rowsText(t, n) {
    const count = Number(n) || 0;
    if (count === 1) return t('datatables.one_row', '1 row');
    return t('datatables.n_rows', '{n} rows', { n: new Intl.NumberFormat().format(count) });
}

function gradeText(t, grade) {
    switch (grade) {
        case 'owner': return t('datatables.grade_owner', GRADE_LABEL.owner);
        case 'editor': return t('datatables.grade_editor', GRADE_LABEL.editor);
        case 'viewer': return t('datatables.grade_viewer', GRADE_LABEL.viewer);
        default: return t('datatables.grade_shared', 'Shared with you');
    }
}

/**
 * How many things depend on this table — `usageCount` from the list payload,
 * which counts DISTINCT CONSUMERS of any kind (an automation, an app, a
 * webpage), not steps.
 *
 * Deliberately NOT "2 automations", which is what the artboard draws: since
 * the usage index went generic an app or a webpage can be inside that
 * number, and a count that names the wrong kind is worse than a count that
 * names none. The Used-by tab has the rows, so that is where the kinds are
 * said out loud.
 */
function UsagePill({ t, count }) {
    const n = Number(count) || 0;
    if (!n) {
        return (
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--text-tertiary)' }}>
                <Workflow className="w-3 h-3" aria-hidden="true" />
                {t('datatables.usage_none_short', 'not used yet')}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5">
            <Workflow className="w-3 h-3" aria-hidden="true" />
            {n === 1
                ? t('datatables.usage_count_one', 'used by 1')
                : t('datatables.usage_count', 'used by {n}', { n })}
        </span>
    );
}

/** The 11px capsule the artboard puts beside a table's name. */
function Chip({ children, tone = 'neutral', title }) {
    const warning = tone === 'warning';
    return (
        <span
            title={title}
            className="inline-flex items-center gap-1 text-[11px] shrink-0"
            style={{
                padding: '1px 7px',
                borderRadius: 999,
                background: warning
                    ? 'color-mix(in srgb, var(--warning) 14%, transparent)'
                    : 'var(--bg-secondary)',
                border: `1px solid ${warning ? 'transparent' : 'var(--border-default)'}`,
                color: warning ? 'var(--warning-ink)' : 'var(--text-secondary)',
            }}
        >
            {children}
        </span>
    );
}
