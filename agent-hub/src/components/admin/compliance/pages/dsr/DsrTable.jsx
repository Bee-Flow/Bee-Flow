/**
 * The DSR register table (artboard 1c): the deadline clock is the FIRST
 * column, the request (number · type · article, masked e-mail · identity) the
 * second. Closed rows read in tertiary text with "completed in n days".
 *
 * The list never holds a full e-mail address (BFSF-441): whatever the server
 * sent, `maskEmail` runs over it before it reaches the DOM.
 */
import { FileText, Globe, Mail, MessageSquare, Phone } from 'lucide-react';
import React, { useMemo } from 'react';
import {
    articleOf, channelOf, clockPropsOf, identityOf, isClosed, receivedAtOf, stateOf, typeKeyOf,
} from './dsrArticles';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableCell, TableRow } from '../../../../shared/DataTable';
import DeadlineClock, { useNow } from '../../../../shared/DeadlineClock';
import { clockState } from '../../../../shared/deadlineMath';
import { formatCalDate, intlLocale } from '../../shared/calendarMath';
import { maskEmail } from '../../shared/maskEmail';
import RegisterStatePill from '../../shared/RegisterStatePill';

/**
 * The register is always sorted by deadline (sortByDeadline): the Deadline
 * header says so with a ↓ and aria-sort, instead of a separate "By deadline"
 * note in the toolbar.
 */
export const DSR_COLUMNS = Object.freeze([
    { id: 'deadline', width: '118px', labelKey: 'compliance.dsr_col_deadline', en: 'Deadline', ariaSort: 'ascending' },
    { id: 'request', width: '1fr', labelKey: 'compliance.dsr_col_request', en: 'Request' },
    { id: 'received', width: '104px', labelKey: 'compliance.dsr_col_received', en: 'Received' },
    { id: 'via', width: '110px', labelKey: 'compliance.dsr_col_via', en: 'Via' },
    { id: 'status', width: '96px', labelKey: 'compliance.dsr_col_status', en: 'Status' },
]);

const CHANNEL = Object.freeze({
    form: { icon: Globe, key: 'compliance.dsr_channel_form', en: 'Form /dsr' },
    email: { icon: Mail, key: 'compliance.dsr_channel_email', en: 'E-mail to DPO' },
    phone: { icon: Phone, key: 'compliance.dsr_channel_phone', en: 'Phone' },
    letter: { icon: FileText, key: 'compliance.dsr_channel_letter', en: 'Letter' },
    other: { icon: MessageSquare, key: 'compliance.dsr_channel_other', en: 'Other' },
});

const IDENTITY = Object.freeze({
    verified_link: { key: 'compliance.dsr_identity_verified', en: 'identity confirmed' },
    verified_manual: { key: 'compliance.dsr_identity_verified', en: 'identity confirmed' },
    pending: { key: 'compliance.dsr_identity_pending', en: 'identity not yet confirmed' },
    employee: { key: 'compliance.dsr_identity_employee', en: 'employee' },
    unknown: { key: 'compliance.dsr_identity_unknown', en: 'identity unknown' },
});

const STATE = Object.freeze({
    pending: { key: 'compliance.dsr_state_pending', en: 'Open' },
    in_progress: { key: 'compliance.dsr_state_in_progress', en: 'In progress' },
    fulfilled: { key: 'compliance.dsr_state_fulfilled', en: 'Completed' },
    rejected: { key: 'compliance.dsr_state_rejected', en: 'Rejected' },
});

export function channelLabel(t, channel) {
    const c = CHANNEL[channel] || CHANNEL.other;
    return t(c.key, c.en);
}

export function identityLabel(t, identity) {
    const i = IDENTITY[identity] || IDENTITY.unknown;
    return t(i.key, i.en);
}

export function stateLabel(t, state) {
    const s = STATE[state] || STATE.pending;
    return t(s.key, s.en);
}

/** English fallbacks for the existing `compliance.dsr_type_*` keys (en-defaults.js). */
const TYPE_EN = Object.freeze({
    'compliance.dsr_type_access': 'Access request',
    'compliance.dsr_type_rectification': 'Rectification request',
    'compliance.dsr_type_deletion': 'Deletion request',
    'compliance.dsr_type_portability': 'Portability request',
    'compliance.dsr_type_restriction': 'Restriction request',
    'compliance.dsr_type_objection': 'Objection',
});

export function typeLabel(t, requestType) {
    const key = typeKeyOf(requestType);
    return key ? t(key, TYPE_EN[key]) : String(requestType || '');
}

/** The masked address for a row — the ONLY way an e-mail reaches the list. */
export function shownEmailOf(row) {
    return maskEmail(row?.subject_email_masked ?? row?.subject_email);
}

function sameDay(a, b) {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function formatTime(ms, locale) {
    return new Intl.DateTimeFormat(intlLocale(locale), { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

/** "12 Aug" · "today 08:51" · "12 Jan '27" — the artboard's received column. */
export function formatReceived(t, ms, now, locale) {
    if (ms === null || ms === undefined) return '';
    if (sameDay(ms, now)) return t('compliance.dsr_received_today', 'today {time}', { time: formatTime(ms, locale) });
    return formatCalDate(ms, { locale, now, year: 'auto' });
}

/** "12 Aug 14:02" for the drawer's timeline and clock meta. */
export function formatDateTime(ms, locale) {
    if (ms === null || ms === undefined) return '';
    return `${formatCalDate(ms, { locale, year: 'auto' })} ${formatTime(ms, locale)}`;
}

export function formatDate(ms, locale) {
    if (ms === null || ms === undefined) return '';
    return formatCalDate(ms, { locale, year: 'auto' });
}

export function ChannelLabel({ channel, className = '' }) {
    const { t } = useTranslation();
    const c = CHANNEL[channel] || CHANNEL.other;
    const Icon = c.icon;
    return (
        <span className={`inline-flex items-center gap-1 min-w-0 ${className}`} data-channel={channel}>
            <Icon size={12} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{t(c.key, c.en)}</span>
        </span>
    );
}

/** The lifecycle state, drawn like every register's (RegisterStatePill): urgency stays with the clock. */
export function DsrStatePill({ state, testId = 'dsr-state' }) {
    const { t } = useTranslation();
    return <RegisterStatePill state={state} testId={testId}>{stateLabel(t, state)}</RegisterStatePill>;
}

/** The row's stripe follows the clock's urgency only: red when overdue, amber when urgent, none otherwise. */
export function accentOf(row, now) {
    const { state } = clockState({ ...clockPropsOf(row), now });
    return state === 'overdue' ? 'error' : state === 'urgent' ? 'warning' : null;
}

function RequestLines({ row, closed, t }) {
    const article = articleOf(row.request_type);
    const email = shownEmailOf(row);
    const identity = identityLabel(t, identityOf(row));
    const second = closed && row.result_summary ? row.result_summary : `${email} · ${identity}`;
    return (
        <div className="min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-mono text-[11px] text-[var(--text-secondary)] shrink-0">#{row.id}</span>
                <span className={`font-medium truncate ${closed ? 'text-[var(--text-secondary)]' : ''}`}>{typeLabel(t, row.request_type)}</span>
                {article && <span className="text-[11px] text-[var(--text-tertiary)] shrink-0">{t('compliance.dsr_article', 'Art. {n}', { n: article })}</span>}
            </div>
            <div className="text-[11px] text-[var(--text-tertiary)] truncate" data-testid="dsr-row-subject">{second}</div>
        </div>
    );
}

export default function DsrTable({
    rows,
    loading = false,
    failed = false,
    selectedId = null,
    onSelect,
    isMobile = false,
    testId = 'dsr-table',
}) {
    const { t, resolvedLocale, locale } = useTranslation();
    const lang = resolvedLocale || locale;
    const now = useNow();
    const columns = useMemo(() => DSR_COLUMNS.map(c => ({
        id: c.id,
        width: c.width,
        ariaSort: c.ariaSort,
        label: c.ariaSort ? <>{t(c.labelKey, c.en)} <span aria-hidden="true">↓</span></> : t(c.labelKey, c.en),
    })), [t]);

    const renderRow = (row, ctx) => {
        const closed = isClosed(row);
        const state = stateOf(row);
        const selected = selectedId !== null && String(selectedId) === String(row.id);
        return (
            <TableRow
                key={row.id}
                columns={ctx.columns}
                selected={selected}
                accent={accentOf(row, now)}
                onClick={onSelect ? () => onSelect(row) : undefined}
                className={closed ? 'text-[var(--text-tertiary)]' : ''}
                testId={`${testId}-row-${row.id}`}
            >
                <TableCell column={columns[0]}>
                    <DeadlineClock variant="row" {...clockPropsOf(row)} testId={`${testId}-clock-${row.id}`} />
                </TableCell>
                <TableCell column={columns[1]}><RequestLines row={row} closed={closed} t={t} /></TableCell>
                <TableCell column={columns[2]}>
                    <span className={closed ? '' : 'text-[var(--text-secondary)]'}>{formatReceived(t, receivedAtOf(row), now, lang)}</span>
                </TableCell>
                <TableCell column={columns[3]}>
                    <ChannelLabel channel={channelOf(row)} className={closed ? '' : 'text-[var(--text-secondary)]'} />
                </TableCell>
                <TableCell column={columns[4]}><DsrStatePill state={state} testId={`${testId}-state-${row.id}`} /></TableCell>
            </TableRow>
        );
    };

    const renderCard = (row) => {
        const closed = isClosed(row);
        const selected = selectedId !== null && String(selectedId) === String(row.id);
        return (
            <button
                type="button"
                onClick={onSelect ? () => onSelect(row) : undefined}
                aria-selected={selected || undefined}
                className={`w-full text-left grid grid-cols-[1fr_104px] gap-3 items-center px-3.5 py-2.5 border-b border-[var(--border-default)] text-xs ${selected ? 'bg-[var(--bg-secondary)] shadow-[inset_3px_0_0_var(--kind-compliance)]' : ''} ${closed ? 'text-[var(--text-tertiary)]' : ''}`}
                data-testid={`${testId}-card-${row.id}`}
            >
                <div className="min-w-0 flex flex-col gap-1">
                    <RequestLines row={row} closed={closed} t={t} />
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-tertiary)]">
                        <span className="whitespace-nowrap">{formatReceived(t, receivedAtOf(row), now, lang)}</span>
                        <ChannelLabel channel={channelOf(row)} />
                        <DsrStatePill state={stateOf(row)} testId={`${testId}-state-${row.id}`} />
                    </div>
                </div>
                <DeadlineClock variant="row" {...clockPropsOf(row)} testId={`${testId}-clock-${row.id}`} />
            </button>
        );
    };

    // DataTable wraps `empty` in its own `<testId>-empty` box; these ids name the text inside it.
    const empty = failed
        ? <div className="text-center text-xs text-[var(--text-tertiary)]" data-testid={`${testId}-failed-text`}>{t('compliance.dsr_load_failed', 'The requests could not be read.')}</div>
        : <div className="text-center text-xs text-[var(--text-tertiary)]" data-testid={`${testId}-empty-text`}>{t('compliance.dsr_empty', 'No data-subject requests received.')}</div>;

    return (
        <DataTable
            columns={columns}
            rows={failed ? [] : (rows || [])}
            loading={loading}
            renderRow={renderRow}
            renderCard={renderCard}
            isMobile={isMobile}
            empty={empty}
            ariaLabel={t('compliance.tab_dsr_requests', 'Requests')}
            testId={testId}
        />
    );
}
