// One row of the notification inbox, and the detail it expands into. Split
// out of NotificationCenter.jsx without a change in behaviour.
import { AlertCircle, AlertTriangle, Bot, GraduationCap, Handshake, Info, MessageSquare, X } from 'lucide-react';
import type { CSSProperties, MouseEvent } from 'react';
import useTranslation from '@/hooks/useTranslation';
import MarkdownRenderer from '../../renderers/MarkdownRenderer';
import type { AppNotification } from './useNotifications';

const CATEGORY_CONFIG = {
    info: { icon: Info, color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.08)', label: 'Info' },
    heads_up: { icon: AlertTriangle, color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.08)', label: 'Heads Up' },
    urgent: { icon: AlertCircle, color: '#ef4444', bg: 'rgba(239, 68, 68, 0.08)', label: 'Urgent' },
    ai_task: { icon: Bot, color: '#0f172a', bg: 'rgba(15, 23, 42, 0.06)', label: 'Automation' },
    // Cowork results used to arrive under the 'ai_task' category and were
    // therefore labelled "Automation" — the name of a different feature, in a
    // different part of the app, that the user had never opened.
    cowork: { icon: Handshake, color: '#0f172a', bg: 'rgba(15, 23, 42, 0.06)', label: 'Cowork' },
    // Learning Center nudges (v2) — the review reminder navigates via `link`,
    // so it stays out of RESULT_CATEGORIES.
    learning: { icon: GraduationCap, color: '#ca8a04', bg: 'rgba(202, 138, 4, 0.08)', label: 'Learning' },
};

type Category = (typeof CATEGORY_CONFIG)[keyof typeof CATEGORY_CONFIG];

const categoryOf = (n: AppNotification): Category =>
    CATEGORY_CONFIG[n.category as keyof typeof CATEGORY_CONFIG] || CATEGORY_CONFIG.info;

// Both kinds carry their whole output in `message` and get the same result
// modal; only the wording around it differs.
const RESULT_CATEGORIES = new Set(['ai_task', 'cowork']);

export const isResult = (n: AppNotification) => RESULT_CATEGORIES.has(n.category || '');

function timeAgo(dateStr: string | null | undefined): string {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    return `${weeks}w ago`;
}

/**
 * Automation credentials expired/revoked notifications carry a deep-link
 * token at the start of the body: `automation_reauth:<provider>\n\n…`. Parse
 * it once so the token is hidden from the rendered message and a one-click
 * Reconnect button is surfaced instead.
 */
function parseReauthToken(msg: string | null | undefined): { provider: string | null; body: string } {
    if (!msg || typeof msg !== 'string') return { provider: null, body: msg || '' };
    const m = msg.match(/^automation_reauth:([a-z0-9_-]+)\n\n?([\s\S]*)$/i);
    if (!m) return { provider: null, body: msg };
    return { provider: m[1].toLowerCase(), body: m[2] };
}

/** What a row can do: go to its link, continue a result in chat, reconnect, delete. */
export interface NotificationRowActions {
    onActivate: (n: AppNotification) => void;
    onDelete: (id: string) => void;
    onNavigateLink: (n: AppNotification) => void;
    onOpenResultInChat: (n: AppNotification, body: string) => void;
    onOpenInDirectChat: (title: string | undefined, content: string, notifId: string) => void;
    onReconnect: (provider: string) => void;
}

const restingBackground = (n: AppNotification, isExpanded: boolean) => (isExpanded
    ? 'rgba(59, 130, 246, 0.04)'
    : n.read ? 'transparent' : 'rgba(59, 130, 246, 0.025)');

export default function NotificationRow({ n, index, isExpanded, actions }: {
    n: AppNotification;
    index: number;
    isExpanded: boolean;
    actions: NotificationRowActions;
}) {
    const { t } = useTranslation();
    const cat = categoryOf(n);
    const CatIcon = cat.icon;
    return (
        <div
            style={{
                padding: '10px 16px',
                cursor: 'pointer',
                background: restingBackground(n, isExpanded),
                borderLeft: n.read ? '3px solid transparent' : `3px solid ${cat.color}`,
                transition: 'all 0.2s ease',
                borderBottom: '1px solid var(--border-subtle, rgba(0,0,0,0.04))',
                animation: `notifFadeIn 0.2s ease ${index * 0.02}s both`,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.018)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = restingBackground(n, isExpanded); }}
            onClick={() => actions.onActivate(n)}
        >
            <div className="[display:flex] [gap:10px] [align-items:flex-start]">
                <div style={{
                    flexShrink: 0, width: 34, height: 34,
                    borderRadius: 10,
                    background: n.read ? 'rgba(0,0,0,0.03)' : cat.bg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: `1px solid ${n.read ? 'rgba(0,0,0,0.05)' : cat.color + '20'}`,
                }}>
                    <CatIcon style={{ width: 16, height: 16, color: n.read ? 'var(--text-muted, #94a3b8)' : cat.color }} />
                </div>
                <RowSummary n={n} cat={cat} isExpanded={isExpanded} />
                <button
                    onClick={(e) => { e.stopPropagation(); actions.onDelete(n.id); }}
                    onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = '#ef4444'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = '0'; e.currentTarget.style.color = 'var(--text-muted, #94a3b8)'; }}
                    title={t('common.delete', 'Delete')}
                    className="notif-delete-btn [background:none] [border:none] [cursor:pointer] [padding:4px] [border-radius:6px] [color:var(--text-muted,#94a3b8)] [opacity:0] [flex-shrink:0]"
                >
                    <X className="w-[14px] h-[14px]" />
                </button>
            </div>

            {isExpanded && <NotificationDetail n={n} cat={cat} actions={actions} />}
        </div>
    );
}

/** The dot, title, age and (folded) first line of a row. */
function RowSummary({ n, cat, isExpanded }: { n: AppNotification; cat: Category; isExpanded: boolean }) {
    const titleStyle: CSSProperties = {
        fontSize: 13,
        fontWeight: n.read ? 400 : 600,
        color: n.read ? 'var(--text-secondary, #64748b)' : 'var(--text-primary, #0f172a)',
        ...(isExpanded
            ? { wordBreak: 'break-word' }
            : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
        ),
        flex: 1,
        lineHeight: 1.4,
    };
    return (
        <div className="[flex:1] min-w-[0]">
            <div className="[display:flex] [align-items:center] [gap:6px] [margin-bottom:2px]">
                {!n.read && (
                    <span style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: cat.color, flexShrink: 0,
                    }} />
                )}
                {/* A result's title is rendered inside the box, beside its
                    button — repeating it here put the same words two lines
                    apart. */}
                <span style={titleStyle}>
                    {isExpanded && isResult(n) ? '' : n.title}
                </span>
                <span className="[font-size:10px] [color:var(--text-muted,#94a3b8)] [flex-shrink:0] [font-weight:500]">
                    {timeAgo(n.created_at)}
                </span>
            </div>
            {n.message && !isExpanded && (
                <p className={`[font-size:12px] [margin:0] [line-height:1.45] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap] ${n.read ? '[color:var(--text-muted,_#94a3b8)]' : '[color:var(--text-secondary,_#64748b)]'}`}>
                    {n.message}
                </p>
            )}
        </div>
    );
}

const PRIMARY_BUTTON: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
    border: 'none', cursor: 'pointer',
    background: 'var(--text-primary, #0f172a)', color: 'var(--bg-primary, #fff)',
};

const stop = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn(); };

/** The expanded box: the actions the notification offers, its body and its category. */
function NotificationDetail({ n, cat, actions }: { n: AppNotification; cat: Category; actions: NotificationRowActions }) {
    const { t } = useTranslation();
    const { provider: reauthProvider, body: cleanedBody } = parseReauthToken(n.message);
    const result = isResult(n);
    return (
        <div className="[margin-top:10px] [margin-left:44px] [padding:12px_14px] [background:var(--bg-secondary,#f8fafc)] [border-radius:10px] [border:1px_solid_var(--border-subtle,rgba(0,0,0,0.05))]">
            {n.link && !result && (
                <div className="[margin-bottom:10px]">
                    <button onClick={stop(() => actions.onNavigateLink(n))} style={PRIMARY_BUTTON}>
                        {t('notifications.open', 'Open')}
                    </button>
                </div>
            )}
            {reauthProvider && (
                <div className="[margin-bottom:10px]">
                    <button onClick={stop(() => actions.onReconnect(reauthProvider))} style={PRIMARY_BUTTON}>
                        {t('notifications.reconnect_provider', 'Reconnect {provider}', { provider: reauthProvider.charAt(0).toUpperCase() + reauthProvider.slice(1) })}
                    </button>
                </div>
            )}
            {result && !reauthProvider && (cleanedBody
                ? <ResultActions n={n} body={cleanedBody} actions={actions} />
                : <EmptyResult n={n} actions={actions} />)}
            {cleanedBody && <DetailBody n={n} body={cleanedBody} reauth={!!reauthProvider} />}
            <div className={`[display:flex] [align-items:center] [gap:8px] [flex-wrap:wrap] ${n.message ? '[margin-top:10px]' : '[margin-top:0]'}`}>
                <span style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 6,
                    background: cat.bg, color: cat.color, fontWeight: 600,
                }}>
                    {cat.label}
                </span>
                <span className="[font-size:11px] [color:var(--text-muted,#94a3b8)]">
                    {n.created_at ? new Date(n.created_at).toLocaleString(undefined, {
                        month: 'short', day: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                    }) : ''}
                </span>
            </div>
        </div>
    );
}

/**
 * One action, and the title beside it. A finished run already shows its
 * whole result below; the only thing left to want is to talk about it, so
 * that is the primary button rather than a second reader window.
 */
function ResultActions({ n, body, actions }: { n: AppNotification; body: string; actions: NotificationRowActions }) {
    const { t } = useTranslation();
    return (
        <div className="[display:flex] [align-items:center] [gap:10px] [margin-bottom:10px] [flex-wrap:wrap]">
            <button
                onClick={stop(() => actions.onOpenResultInChat(n, body))}
                data-testid="notif-open-in-chat"
                className="[display:inline-flex] [align-items:center] [gap:6px] [padding:8px_16px] [border-radius:9px] [font-size:12.5px] [font-weight:600] [border:none] [cursor:pointer] [flex-shrink:0] [background:var(--text-primary,#0f172a)] [color:var(--bg-primary,#fff)]"
            >
                <MessageSquare className="w-[14px] h-[14px]" />
                {t('notifications.open_result_in_chat', 'Open result in chat')}
            </button>
            <span className="[font-size:13px] [font-weight:600] min-w-[0] [color:var(--text-primary,#0f172a)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                {n.title}
            </span>
        </div>
    );
}

/** A result that saved no text: say so, and offer the run itself. */
function EmptyResult({ n, actions }: { n: AppNotification; actions: NotificationRowActions }) {
    const cowork = n.category === 'cowork';
    return (
        <div className="[margin-bottom:10px]">
            <p className="[font-size:13px] [color:var(--text-secondary,#64748b)] [margin:0_0_8px_0] [line-height:1.6]">
                {cowork
                    ? 'This ran, but produced no text to show. Open it to see the run.'
                    : 'This automation ran, but no text result was saved. Open the chat to see the run.'}
            </p>
            <button
                onClick={stop(() => {
                    // A cowork run has no chat thread to continue — its
                    // history pane is where the run lives.
                    if (cowork && n.link) actions.onNavigateLink(n);
                    else actions.onOpenInDirectChat(n.title, '', n.id);
                })}
                className="[display:flex] [align-items:center] [gap:5px] [padding:6px_14px] [border-radius:8px] [font-size:12px] [font-weight:600] [border:none] [cursor:pointer] [background:var(--bg-secondary,rgba(0,0,0,0.04))] [color:var(--text-primary,#0f172a)]"
            >
                {cowork ? 'Open in Cowork' : 'Open chat'}
            </button>
        </div>
    );
}

/** The message itself: Markdown for an automation result, plain text otherwise. */
function DetailBody({ n, body, reauth }: { n: AppNotification; body: string; reauth: boolean }) {
    if (n.category === 'ai_task' && !reauth) {
        return (
            <div className="[font-size:13px] [color:var(--text-primary,#0f172a)] [line-height:1.6] [word-break:break-word] max-h-[600px] [overflow-y:auto]">
                <MarkdownRenderer content={body} />
            </div>
        );
    }
    return (
        <p className="[font-size:13px] [color:var(--text-primary,#0f172a)] [margin:0] [line-height:1.6] [word-break:break-word] [white-space:pre-wrap]">
            {body}
        </p>
    );
}
