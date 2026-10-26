// The notification inbox popover: header, All/Unread filter and the list,
// grouped by age. Split out of NotificationCenter.jsx without a change in
// behaviour.
import { Bell, Check, CheckCheck, BellOff } from 'lucide-react';
import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import useTranslation from '@/hooks/useTranslation';
import NotificationRow from './NotificationRow';
import type { NotificationRowActions } from './NotificationRow';
import type { AppNotification } from './useNotifications';

export type NotifFilter = 'all' | 'unread';

type TimeGroup = 'today' | 'this_week' | 'older';

const TIME_GROUP_LABELS: Record<TimeGroup, string> = {
    today: 'Today',
    this_week: 'Earlier This Week',
    older: 'Older',
};

function getTimeGroup(dateStr: string | null | undefined): TimeGroup {
    if (!dateStr) return 'older';
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now.getTime() - date.getTime();
    const diffH = diffMs / (1000 * 60 * 60);
    if (diffH < 24 && date.getDate() === now.getDate()) return 'today';
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    if (date > weekAgo) return 'this_week';
    return 'older';
}

type ListItem = { type: 'header'; group: TimeGroup; label: string } | { type: 'notification'; data: AppNotification };

/** The notifications with a header before each age group. */
function groupByAge(list: AppNotification[]): ListItem[] {
    const groups: ListItem[] = [];
    let lastGroup: TimeGroup | null = null;
    for (const n of list) {
        const group = getTimeGroup(n.created_at);
        if (group !== lastGroup) {
            groups.push({ type: 'header', group, label: TIME_GROUP_LABELS[group] });
            lastGroup = group;
        }
        groups.push({ type: 'notification', data: n });
    }
    return groups;
}

/**
 * Phones get a near-full-width sheet anchored to the viewport so the 520px
 * popover can't spill off the right edge. (The mobile drawer's slide-in
 * transform has reverted by the time the user taps the bell, so
 * position:fixed anchors to the viewport.)
 */
function panelStyle(isMobile: boolean, isIcon: boolean): CSSProperties {
    return {
        ...(isMobile
            ? { position: 'fixed', top: 60, left: 12, right: 12, maxHeight: 'calc(100dvh - 80px)' }
            : {
                position: 'absolute',
                ...(isIcon
                    ? { top: '100%', left: 0, marginTop: 8 }
                    : { bottom: '100%', left: 0, marginBottom: 8 }),
                width: 520,
                maxHeight: 680,
            }),
        background: 'var(--bg-card, #ffffff)',
        border: '1px solid var(--border-subtle, rgba(0,0,0,0.06))',
        borderRadius: 16,
        boxShadow: '0 20px 60px rgba(0,0,0,0.15), 0 4px 16px rgba(0,0,0,0.08)',
        display: 'flex', flexDirection: 'column',
        zIndex: 1000,
        animation: `${isIcon ? 'notifSlideDown' : 'notifSlideUp'} 0.2s cubic-bezier(0.16, 1, 0.3, 1)`,
        overflow: 'hidden',
    };
}

export interface NotificationPanelProps {
    isMobile: boolean;
    isIcon: boolean;
    notifications: AppNotification[];
    unreadCount: number;
    loading: boolean;
    filter: NotifFilter;
    setFilter: (f: NotifFilter) => void;
    onMarkAllRead: () => void;
    expandedId: string | null;
    actions: NotificationRowActions;
}

export default function NotificationPanel(p: NotificationPanelProps) {
    const filtered = useMemo(() => (
        p.filter === 'unread' ? p.notifications.filter(n => !n.read) : p.notifications
    ), [p.notifications, p.filter]);
    const grouped = useMemo(() => groupByAge(filtered), [filtered]);

    let body;
    if (p.loading && p.notifications.length === 0) body = <LoadingState />;
    else if (filtered.length === 0) body = <EmptyState filter={p.filter} />;
    else {
        body = grouped.map((item, index) => (item.type === 'header'
            ? <GroupHeader key={`group-${item.group}`} label={item.label} />
            : <NotificationRow key={item.data.id} n={item.data} index={index} isExpanded={p.expandedId === item.data.id} actions={p.actions} />));
    }
    return (
        <div data-surface="opaque" style={panelStyle(p.isMobile, p.isIcon)}>
            <PanelHeader unreadCount={p.unreadCount} filter={p.filter} setFilter={p.setFilter} onMarkAllRead={p.onMarkAllRead} />
            {/* Notification list */}
            <div className="[flex:1] [overflow-y:auto] [padding:2px_0]">
                {body}
            </div>
        </div>
    );
}

function PanelHeader({ unreadCount, filter, setFilter, onMarkAllRead }: {
    unreadCount: number; filter: NotifFilter; setFilter: (f: NotifFilter) => void; onMarkAllRead: () => void;
}) {
    const { t } = useTranslation();
    const filters: Array<{ id: NotifFilter; label: string }> = [{ id: 'all', label: 'All' }, { id: 'unread', label: 'Unread' }];
    return (
        <div className="[padding:12px_16px] [border-bottom:1px_solid_var(--border-subtle,rgba(0,0,0,0.06))] [display:flex] [align-items:center] [gap:10px] [background:var(--bg-card,#ffffff)]">
            <div className="w-[32px] h-[32px] [border-radius:9px] [background:rgba(59,130,246,0.08)] [display:flex] [align-items:center] [justify-content:center] [border:1px_solid_rgba(59,130,246,0.15)] [flex-shrink:0]">
                <Bell className="w-[15px] h-[15px] [color:#3b82f6]" />
            </div>
            <div className="[flex:1] [font-size:14px] [font-weight:700] [color:var(--text-primary,#0f172a)]">
                {t('notifications.title', 'Notifications')}
                {unreadCount > 0 && (
                    <span className="[margin-left:8px] [background:linear-gradient(135deg,#ef4444,#dc2626)] [color:#fff] [font-size:10px] [font-weight:700] [border-radius:10px] [padding:2px_7px] [line-height:1.3]">{unreadCount}</span>
                )}
            </div>
            {/* Filter toggle */}
            <div className="[display:flex] [gap:2px] [background:var(--bg-secondary,rgba(0,0,0,0.03))] [border-radius:8px] [padding:2px]">
                {filters.map(f => (
                    <button
                        key={f.id}
                        onClick={() => setFilter(f.id)}
                        style={{
                            background: filter === f.id ? 'var(--bg-card, #fff)' : 'transparent',
                            border: 'none', cursor: 'pointer',
                            fontSize: 11, fontWeight: 600,
                            padding: '4px 10px', borderRadius: 6,
                            color: filter === f.id ? '#3b82f6' : 'var(--text-muted, #94a3b8)',
                            transition: 'all 0.15s',
                            boxShadow: filter === f.id ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
                        }}
                    >{f.label}</button>
                ))}
            </div>
            {unreadCount > 0 && (
                <button
                    onClick={onMarkAllRead}
                    className="[background:none] [border:none] [cursor:pointer] [font-size:11px] [color:#3b82f6] [font-weight:500] [display:flex] [align-items:center] [gap:4px] [padding:4px_8px] [border-radius:6px]"
                    title={t('notifications.mark_all_read_title', 'Mark all as read')}
                >
                    <CheckCheck className="w-[13px] h-[13px]" />
                </button>
            )}
        </div>
    );
}

function LoadingState() {
    const { t } = useTranslation();
    return (
        <div className="[padding:40px] [text-align:center] [color:var(--text-muted,#94a3b8)] [font-size:13px]">
            <div className="w-[28px] h-[28px] [margin:0_auto_10px] [border:2px_solid_rgba(59,130,246,0.2)] [border-top-color:#3b82f6] [border-radius:50%] [animation:notifSpin_0.8s_linear_infinite]" />
            {t('notifications.loading', 'Loading notifications...')}
        </div>
    );
}

function EmptyState({ filter }: { filter: NotifFilter }) {
    const unread = filter === 'unread';
    return (
        <div className="[padding:48px_32px] [text-align:center] [color:var(--text-muted,#94a3b8)]">
            <div className="w-[52px] h-[52px] [margin:0_auto_14px] [border-radius:16px] [display:flex] [align-items:center] [justify-content:center] [background:rgba(59,130,246,0.06)]">
                {unread
                    ? <Check className="w-[24px] h-[24px] [color:#22c55e] [opacity:0.6]" />
                    : <BellOff className="w-[24px] h-[24px] [color:#3b82f6] [opacity:0.4]" />
                }
            </div>
            <p className="[margin:0_0_4px] [font-size:14px] [font-weight:600] [color:var(--text-secondary,#64748b)]">
                {unread ? 'All caught up!' : 'No notifications yet'}
            </p>
            <p className="[margin:0] [font-size:12px] [color:var(--text-muted,#94a3b8)]">
                {unread ? 'You\'ve read all your notifications' : 'Notifications will appear here'}
            </p>
        </div>
    );
}

function GroupHeader({ label }: { label: string }) {
    return (
        <div
            className="[padding:8px_18px_4px] [font-size:10px] [font-weight:700] [color:var(--text-muted,#94a3b8)] [text-transform:uppercase] [letter-spacing:0.08em] [background:var(--bg-secondary,rgba(0,0,0,0.015))] [border-bottom:1px_solid_var(--border-subtle,rgba(0,0,0,0.04))]"
        >
            {label}
        </div>
    );
}
