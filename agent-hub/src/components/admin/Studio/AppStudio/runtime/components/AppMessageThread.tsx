import { useEffect, useMemo, useRef, type JSX } from 'react';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import EmailHtmlBody from '@/components/support/EmailHtmlBody';
import { hoverable } from '../hoverable';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { ROLE_COLORS } from '../styleResolver.constants';
import type { BindingInput, StaticBinding } from '../resolveBinding.types';
import type { NodeProps } from './appNode.types';
import { EmptyText, ErrorText, SkeletonLines, displayValue, useStickyBinding } from '../uiBits';
import type { MessageThreadProps } from './AppMessageThread.types';
import { toneStyle, formatStamp, textOrNull, initials, resolveSide } from './AppMessageThread.helpers';
import { Chips } from './Chips';

/**
 * App Studio runtime — 'message_thread'. Spec: server/appStudio/componentSpecs.js.
 *
 * A conversation, not a list. The thing a repeater genuinely cannot do is give
 * each row a DIFFERENT appearance based on one of its fields: `computed`
 * overrides props, never style. `sideMap` is that missing piece — one list
 * mapping a row value ('requester', 'agent', 'system', …) to a side and a tone.
 *
 * HTML bodies render through the shared EmailHtmlBody, which is imported rather
 * than copied on purpose: the "sandbox without allow-scripts" invariant that
 * makes rendering a stranger's e-mail safe must have exactly one home. A row
 * that HAS such a body drops the tinted bubble for a white card — see `paper`
 * below; mail carries its own colours and cannot be laid on a tinted ground.
 */

const SIDE_ALIGN: Record<string, string> = { left: 'items-start', right: 'items-end', center: 'items-center' };

/**
 * Would this HTML paint anything?
 *
 * The html branch used to be taken on plain truthiness, and mail is full of
 * bodies that are truthy and empty: Gmail sends `<div dir="ltr"><br></div>` for
 * a message whose content is an attachment or a bare subject line. That is a
 * non-empty string, so the text fallback was skipped and the reader got a blank
 * 120px white frame — the iframe's minimum — sitting inside a coloured bubble.
 *
 * Tags that ARE the content (an image, a table, a rule) count even with no text
 * beside them; a signature logo alone is a real message body.
 */
function hasVisibleHtml(html: unknown) {
    if (typeof html !== 'string' || !html.trim()) return false;
    if (/<(img|table|video|iframe|hr)[\s>/]/i.test(html)) return true;
    const text = html
        .replace(/<[^>]*>/g, ' ')
        // &nbsp; is whitespace; every other entity stands for a real character.
        .replace(/&nbsp;/gi, ' ')
        .replace(/&[a-z#0-9]+;/gi, 'x');
    return text.trim().length > 0;
}

/** Marks a row that came from eventsSource rather than from the conversation. */
const EVENT_FLAG = '__appThreadEvent';

/** Stand-in binding so the optional sources still resolve on every render. */
const EMPTY_BINDING: StaticBinding = { kind: 'static', value: [] };

/** Attachment rows grouped by their match key, once per source rather than per message. */
function groupAttachments(attSource: unknown, attachmentMatchKey: string | null) {
    const map = new Map();
    if (!attachmentMatchKey) return map;
    for (const a of Array.isArray(attSource) ? attSource : []) {
        if (!a || typeof a !== 'object') continue;
        const raw = walkPath(a, attachmentMatchKey);
        if (raw == null || raw === '') continue;
        const key = String(raw);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(a);
    }
    return map;
}

/** The white sheet an HTML mail sits on, with the side's accent edge in the tone's colour. */
function paperStyle(side: string, tone: string) {
    return {
        background: '#ffffff',
        color: '#1a1a1a',
        padding: 0,
        overflow: 'hidden',
        border: '1px solid var(--border-default)',
        [side === 'right' ? 'borderRightWidth' : 'borderLeftWidth']: '3px',
        [side === 'right' ? 'borderRightColor' : 'borderLeftColor']: ROLE_COLORS[tone] || ROLE_COLORS.primary,
    };
}

export default function AppMessageThread({ node }: NodeProps<MessageThreadProps>) {
    const { t } = useTranslation();
    const { mode, runAction, actionState, dataState, scope } = useRuntime();
    const {
        bodyField = 'body', htmlField = null, authorField = 'author',
        timestampField = 'created_at', sideField = null, sideMap = [],
        attachmentsField = null, attachmentLabelKey = 'filename',
        attachmentMatchKey = null,
        citationsField = null, citationLabelKey = 'title',
        emailField = null, toField = null, subjectField = null, showAvatar = false,
        centerMeta = 'hidden',
        eventsBodyField = 'detail', eventsTimestampField = 'at',
        rowLimit = 100, emptyText = t('studio_apps_runtime.thread.empty', 'No messages yet.'),
    } = node.props || {};
    // Any of these turns the plain author line into a mail header.
    const mailHead = !!(emailField || toField || subjectField || showAvatar);
    const binding = resolveBinding(node.props?.source, { actionState, dataState, scope });
    // Sticky: a polling tick must not blank the conversation for a moment. This
    // is what makes auto-refresh feel like an inbox rather than a page reload.
    const { value: source, isLoading, error, errorCode } = useStickyBinding(binding);

    // Both extra sources resolve unconditionally against a static empty binding
    // when unset — a hook that only runs for some props is a hook-order crash
    // waiting for the first author who leaves one out.
    const attBinding = resolveBinding(node.props?.attachmentsSource || EMPTY_BINDING, { actionState, dataState, scope });
    const { value: attSource } = useStickyBinding(attBinding);
    const evBinding = resolveBinding(node.props?.eventsSource || EMPTY_BINDING, { actionState, dataState, scope });
    const { value: evSource } = useStickyBinding(evBinding);

    // Attachments are grouped ONCE, not re-scanned per message: a thread of 100
    // mails against a few hundred attachment rows is otherwise a quadratic
    // sweep on every render.
    const attByKey = useMemo(() => groupAttachments(attSource, attachmentMatchKey), [attSource, attachmentMatchKey]);
    const listRef = useRef<HTMLDivElement>(null);
    const limit = Number.isInteger(rowLimit) && rowLimit > 0 ? rowLimit : 100;
    const all = useMemo(() => {
        const msgs = (Array.isArray(source) ? source : []).filter((r) => r && typeof r === 'object');
        const evs = (Array.isArray(evSource) ? evSource : [])
            .filter((r) => r && typeof r === 'object')
            .map((e) => ({ ...e, [EVENT_FLAG]: true }));
        if (evs.length === 0) return msgs;
        const at = (r: { id?: string; pid?: string; body?: string; at: string; detail?: string; __appThreadEvent?: boolean }) => {
            const raw = walkPath(r, r[EVENT_FLAG] ? eventsTimestampField : timestampField);
            const n = raw ? Date.parse(String(raw)) : NaN;
            return Number.isFinite(n) ? n : 0;
        };
        // Messages are concatenated first so that a tie — an event stamped at
        // the same second as the mail that caused it — keeps the mail above the
        // note about it. Array.sort is stable, which is what makes that hold.
        return [...msgs, ...evs].sort((a, b) => at(a) - at(b));
    }, [source, evSource, eventsTimestampField, timestampField]);

    // Keep the TAIL, unlike timeline's head slice: in a conversation the newest
    // messages are the ones you must not drop.
    const rows = all.length > limit ? all.slice(all.length - limit) : all;

    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [rows.length]);

    // A failed conversation fetch reported "No messages yet." — the one empty
    // state a user is most likely to believe.
    if (error) return <ErrorText error={error} errorCode={errorCode} />;
    if (isLoading && rows.length === 0) return <SkeletonLines lines={4} />;
    if (rows.length === 0) return <EmptyText text={emptyText} />;

    const isRun = mode === 'run';
    const clickable = isRun && node.onRowClick;
    const size = node.style?.size || 'md';
    const textSize = size === 'sm' ? 'text-xs' : 'text-sm';

    return (
        <div
            ref={listRef}
            className="flex flex-col gap-3 h-full overflow-y-auto min-h-0"
            data-app-message-thread="true"
        >
            {rows.map((row, i) => {
                // An event is always a center line: it is not a party to the
                // conversation, so it takes no side, no author and no avatar.
                const isEvent = row[EVENT_FLAG] === true;
                const { side, tone } = isEvent
                    ? { side: 'center', tone: 'neutral' }
                    : resolveSide(row, sideField, sideMap);
                const rawAuthor = !isEvent && authorField ? walkPath(row, authorField) : null;
                const author = !isEvent && authorField ? displayValue(rawAuthor) : null;
                const stampField = isEvent ? eventsTimestampField : timestampField;
                const stamp = stampField ? formatStamp(walkPath(row, stampField)) : null;
                const email = !isEvent && emailField ? walkPath(row, emailField) : null;
                const to = !isEvent && toField ? walkPath(row, toField) : null;
                const subject = !isEvent && subjectField ? walkPath(row, subjectField) : null;
                const html = !isEvent && htmlField ? walkPath(row, htmlField) : null;
                const text = isEvent
                    ? walkPath(row, eventsBodyField)
                    : (bodyField ? walkPath(row, bodyField) : null);
                const showHtml = hasVisibleHtml(html);
                // attachmentsField wins when both are set: a row that carries its
                // own list is the more specific answer.
                const attachments = isEvent ? null : (attachmentsField
                    ? walkPath(row, attachmentsField)
                    : (attachmentMatchKey ? attByKey.get(String(walkPath(row, attachmentMatchKey) ?? '')) : null));
                const citations = !isEvent && citationsField ? walkPath(row, citationsField) : null;

                // The meta line lives ABOVE the bubble, not inside it. Inside, it
                // has to be tinted to survive a filled bubble, it competes with
                // the message for the eye, and it pushes every body down by a
                // line — three problems that all disappear by moving it out.
                // With the mail-header props set it becomes a header block:
                // name + <email>, a "To/Subject" line, time on the right.
                const headerInside = mailHead && showHtml;
                let meta: JSX.Element | null = null;
                if (side !== 'center') {
                    if (mailHead) {
                        meta = <MailHeadMeta t={t} side={side} headerInside={headerInside} showAvatar={showAvatar} rawAuthor={rawAuthor} author={author} email={email} to={to} subject={subject} stamp={stamp} />;
                    } else if (author || stamp) {
                        meta = <PlainMeta side={side} author={author} stamp={stamp} />;
                    }
                }

                // A real e-mail is a sheet of paper, not a chat bubble. The body
                // arrives with its own inline colours — the live Gmail HTML in
                // this app pins `color:rgb(0,0,0)` — so a tinted or dark ground
                // behind it produces black on black. Support already solved this
                // the same way (SupportInboxPanel, SupportStudio): an HTML body
                // REPLACES the filled bubble with a white card. Side and tone
                // survive as the alignment plus an accent edge, so you can still
                // tell the two parties apart at a glance.
                const paper = showHtml ? paperStyle(side, tone) : null;

                const bubble = (
                    <div
                        className={`px-3 py-2 rounded-lg ${side === 'center' ? 'text-xs italic' : textSize}`}
                        style={{
                            ...toneStyle(side, tone),
                            ...paper,
                            borderRadius: 'var(--app-radius)',
                            // The 85% cap is a chat convention: a bubble that runs
                            // the full width stops reading as one side of a
                            // conversation. A sheet of paper has no such tell —
                            // every mail client shows a message full width, and
                            // capping it wastes the column while forcing the body
                            // to wrap early. Side survives as the accent edge.
                            maxWidth: side === 'center' || showHtml ? '100%' : '85%',
                        }}
                        data-app-thread-side={side}
                        data-app-thread-tone={tone}
                        data-app-thread-html={showHtml ? 'true' : undefined}
                    >
                        {headerInside ? meta : null}
                        {showHtml ? (
                            <EmailHtmlBody html={String(html)} />
                        ) : (
                            <div className="whitespace-pre-wrap break-words">
                                {/* System (center) rows can carry their time inline. */}
                                {side === 'center' && centerMeta === 'inline' && stamp ? `${stamp} · ` : null}
                                {displayValue(textOrNull(text))}
                            </div>
                        )}

                        {/* The card zeroes its own padding so the mail can bleed
                            to the edge; the chips still need their gutter. */}
                        <div className={showHtml ? 'px-3 pb-2' : ''}>
                            <Chips items={attachments} labelKey={attachmentLabelKey} testId="attachments" />
                            <Chips items={citations} labelKey={citationLabelKey} testId="citations" />
                        </div>
                    </div>
                );

                return (
                    <div
                        key={i}
                        className={`flex flex-col ${SIDE_ALIGN[side] || SIDE_ALIGN.left}`}
                        data-app-thread-row={i}
                    >
                        {headerInside ? null : meta}
                        {clickable ? (
                            <button
                                type="button"
                                className="text-left cursor-pointer max-w-full"
                                onClick={() => runAction(node.onRowClick as string, { formValues: row, item: row })}
                            >
                                {bubble}
                            </button>
                        ) : bubble}
                    </div>
                );
            })}
        </div>
    );
}

/** A field value as text, or null when it is missing or empty. */
function presentString(value: unknown) {
    return value != null && value !== '' ? String(value) : null;
}

interface MailHeadMetaProps {
    t: TranslateFn;
    side: string;
    headerInside: boolean;
    showAvatar: boolean;
    rawAuthor: unknown;
    author: string | null;
    email: unknown;
    to: unknown;
    subject: unknown;
    stamp: string | null;
}

/** The mail-header meta: avatar, name and <email>, time, and a To/Subject line; inside the sheet when the body is HTML. */
function MailHeadMeta({ t, side, headerInside, showAvatar, rawAuthor, author, email, to, subject, stamp }: MailHeadMetaProps) {
    const emailStr = presentString(email);
    const toStr = presentString(to);
    const subjStr = presentString(subject);
    const secondLine = [
        toStr ? t('studio_apps_runtime.thread.to', 'To: {value}', { value: toStr }) : null,
        subjStr ? t('studio_apps_runtime.thread.subject', 'Subject: {value}', { value: subjStr }) : null,
    ].filter(Boolean).join(' · ');
    // On a sheet the header goes INSIDE, above a rule —
    // where every mail client puts it, and where artboard 2
    // puts it. Floated outside and to one side it reads as a
    // chat nameplate and drifts away from its own body. The
    // sheet is always white, so its text cannot use the
    // theme's tokens: in dark mode those are near-white and
    // would vanish.
    const ink = headerInside ? '#16191f' : 'var(--text-secondary)';
    const inkMuted = headerInside ? '#67707b' : 'var(--text-muted)';
    return (
        <div
            className={headerInside ? 'flex items-start gap-2 px-3 py-2' : 'flex items-start gap-2 mb-1 px-1'}
            style={headerInside ? { borderBottom: '1px solid #e0e3e8' } : undefined}
            data-app-thread-meta={side}
            data-app-thread-mailhead="true"
        >
            {showAvatar ? (
                <span
                    className="inline-flex items-center justify-center rounded-full shrink-0 text-[11px] font-semibold w-[28px] h-[28px] [background:var(--app-primary-soft)] [color:var(--app-primary)]!"
                    data-app-thread-avatar="true"
                >
                    {initials(rawAuthor)}
                </span>
            ) : null}
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                    {author ? (
                        <span className="text-xs font-semibold truncate" {...hoverable(author)} style={{ color: ink }}>{author}</span>
                    ) : null}
                    {emailStr ? (
                        <span className="text-[11px] truncate" {...hoverable(emailStr)} style={{ color: inkMuted }}>{`<${emailStr}>`}</span>
                    ) : null}
                    {stamp ? (
                        <span className="ml-auto shrink-0 text-[11px]" style={{ color: inkMuted }}>{stamp}</span>
                    ) : null}
                </div>
                {secondLine ? (
                    <div className="truncate" {...hoverable(secondLine)} style={{ fontSize: '11.5px', color: inkMuted }}>{secondLine}</div>
                ) : null}
            </div>
        </div>
    );
}

/** The chat meta line above a bubble: author and time, mirrored on the right side. */
function PlainMeta({ side, author, stamp }: { side: string; author: string | null; stamp: string | null }) {
    return (
            <div
                className={`flex items-baseline gap-2 mb-1 px-1 ${side === 'right' ? 'flex-row-reverse' : ''}`}
                data-app-thread-meta={side}
            >
                {author ? (
                    <span className="text-xs font-medium text-[var(--text-secondary)]">{author}</span>
                ) : null}
                {stamp ? (
                    <span className="text-[11px] text-[var(--text-muted)]">{stamp}</span>
                ) : null}
            </div>
    );
}
