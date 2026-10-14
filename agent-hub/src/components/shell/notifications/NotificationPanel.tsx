// The notification inbox popover: header, All/Unread filter and the list,
// grouped by age. Split out of NotificationCenter.jsx without a change in
// behaviour.
import { Bell, Check, CheckCheck, BellOff } from 'lucide-react';
import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import useTranslation from '../../../hooks/useTranslation';
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
            <div style={{ flex: 1, overflowY: 'auto', padding: '2px 0' }}>
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
        <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle, rgba(0,0,0,0.06))',
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'var(--bg-card, #ffffff)',
        }}>
            <div style={{
                width: 32, height: 32, borderRadius: 9,
                background: 'rgba(59,130,246,0.08)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '1px solid rgba(59,130,246,0.15)',
                flexShrink: 0,
            }}>
                <Bell style={{ width: 15, height: 15, color: '#3b82f6' }} />
            </div>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: 'var(--text-primary, #0f172a)' }}>
                {t('notifications.title', 'Notifications')}
                {unreadCount > 0 && (
                    <span style={{
                        marginLeft: 8,
                        background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                        color: '#fff', fontSize: 10, fontWeight: 700,
                        borderRadius: 10, padding: '2px 7px', lineHeight: 1.3,
                    }}>{unreadCount}</span>
                )}
            </div>
            {/* Filter toggle */}
            <div style={{
                display: 'flex', gap: 2,
                background: 'var(--bg-secondary, rgba(0,0,0,0.03))',
                borderRadius: 8, padding: 2,
            }}>
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
                    style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontSize: 11, color: '#3b82f6', fontWeight: 500,
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '4px 8px', borderRadius: 6,
                    }}
                    title={t('notifications.mark_all_read_title', 'Mark all as read')}
                >
                    <CheckCheck style={{ width: 13, height: 13 }} />
                </button>
            )}
        </div>
    );
}

function LoadingState() {
    const { t } = useTranslation();
    return (
        <div style={{
            padding: 40, textAlign: 'center',
            color: 'var(--text-muted, #94a3b8)', fontSize: 13,
        }}>
            <div style={{
                width: 28, height: 28, margin: '0 auto 10px',
                border: '2px solid rgba(59,130,246,0.2)',
                borderTopColor: '#3b82f6',
                borderRadius: '50%',
                animation: 'notifSpin 0.8s linear infinite',
            }} />
            {t('notifications.loading', 'Loading notifications...')}
        </div>
    );
}

function EmptyState({ filter }: { filter: NotifFilter }) {
    const unread = filter === 'unread';
    return (
        <div style={{
            padding: '48px 32px', textAlign: 'center',
            color: 'var(--text-muted, #94a3b8)',
        }}>
            <div style={{
                width: 52, height: 52, margin: '0 auto 14px',
                borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(59,130,246,0.06)',
            }}>
                {unread
                    ? <Check style={{ width: 24, height: 24, color: '#22c55e', opacity: 0.6 }} />
                    : <BellOff style={{ width: 24, height: 24, color: '#3b82f6', opacity: 0.4 }} />
                }
            </div>
            <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600, color: 'var(--text-secondary, #64748b)' }}>
                {unread ? 'All caught up!' : 'No notifications yet'}
            </p>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted, #94a3b8)' }}>
                {unread ? 'You\'ve read all your notifications' : 'Notifications will appear here'}
            </p>
        </div>
    );
}

function GroupHeader({ label }: { label: string }) {
    return (
        <div
            style={{
                padding: '8px 18px 4px',
                fontSize: 10, fontWeight: 700,
                color: 'var(--text-muted, #94a3b8)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                background: 'var(--bg-secondary, rgba(0,0,0,0.015))',
                borderBottom: '1px solid var(--border-subtle, rgba(0,0,0,0.04))',
            }}
        >
            {label}
        </div>
    );
}
