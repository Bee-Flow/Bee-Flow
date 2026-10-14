// The bell that opens the inbox (two variants) and the result modal. Split
// out of NotificationCenter.jsx without a change in behaviour.
import { Bell, Bot, X } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import MarkdownRenderer from '../../renderers/MarkdownRenderer';

/** Compact icon-only trigger (sits in a top bar). */
export function IconTrigger({ open, unreadCount, onToggle }: { open: boolean; unreadCount: number; onToggle: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            onClick={onToggle}
            aria-label={t('notifications.title', 'Notifications')}
            title={t('notifications.title', 'Notifications')}
            className={`relative p-1.5 rounded-lg transition-colors ${open ? 'bg-[var(--bg-tertiary)] text-[var(--accent-primary)]' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'}`}
            data-testid="sidebar-notifications"
        >
            <Bell className="w-[18px] h-[18px]" strokeWidth={1.75} />
            {unreadCount > 0 && (
                <span style={{
                    position: 'absolute',
                    top: 1, right: 1,
                    minWidth: 14, height: 14,
                    borderRadius: 7, padding: '0 3px',
                    background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                    color: '#fff',
                    fontSize: 9, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    lineHeight: 1,
                    boxShadow: '0 2px 4px rgba(220,38,38,0.3)',
                }}>
                    {unreadCount > 9 ? '9+' : unreadCount}
                </span>
            )}
        </button>
    );
}

/** Sidebar-style trigger row. */
export function RowTrigger({ open, unreadCount, onToggle }: { open: boolean; unreadCount: number; onToggle: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            onClick={onToggle}
            aria-label={t('notifications.title', 'Notifications')}
            title={t('notifications.title', 'Notifications')}
            className={`w-full flex items-center gap-2.5 px-3 h-9 rounded-lg transition-colors text-left ${open ? 'bg-[var(--item-active-bg)]' : 'hover:bg-[var(--item-hover-bg)]'}`}
            data-testid="sidebar-notifications"
        >
            <Bell className={`w-4 h-4 ${open ? 'text-[var(--accent-primary)]' : 'text-[var(--text-tertiary)]'}`} strokeWidth={1.75} />
            <span className={`text-[13px] ${open ? 'font-bold text-black' : 'text-black'}`}>
                {t('notifications.title', 'Notifications')}
            </span>
            {unreadCount > 0 && (
                <span style={{
                    marginLeft: 'auto',
                    minWidth: 18, height: 18,
                    borderRadius: 9, padding: '0 5px',
                    background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                    color: '#fff',
                    fontSize: 10, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    lineHeight: 1,
                    boxShadow: '0 2px 4px rgba(220,38,38,0.3)',
                }}>
                    {unreadCount > 99 ? '99+' : unreadCount}
                </span>
            )}
        </button>
    );
}

export interface ResultModalData {
    title?: string;
    content: string;
    category?: string;
    notifId?: string;
}

/** An automation or Cowork result, read in full, with a way into chat. */
export function ResultModal({ modal, onClose, onDiscuss }: {
    modal: ResultModalData;
    onClose: () => void;
    onDiscuss: () => void;
}) {
    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed', inset: 0, zIndex: 2000,
                background: 'rgba(0,0,0,0.5)',
                backdropFilter: 'blur(4px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 24,
                animation: 'resultModalBgIn 0.2s ease',
            }}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                style={{
                    width: '100%', maxWidth: 720, maxHeight: '85vh',
                    background: 'var(--bg-card, #ffffff)',
                    borderRadius: 20,
                    boxShadow: '0 25px 80px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.12)',
                    display: 'flex', flexDirection: 'column',
                    overflow: 'hidden',
                    animation: 'resultModalIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
                    border: '1px solid var(--border-subtle, rgba(0,0,0,0.06))',
                }}
            >
                <ResultModalHeader modal={modal} onClose={onClose} onDiscuss={onDiscuss} />

                <div style={{
                    flex: 1, overflowY: 'auto',
                    padding: '20px 24px',
                    fontSize: 14, lineHeight: 1.7,
                    color: 'var(--text-primary, #0f172a)',
                }}>
                    <MarkdownRenderer content={modal.content} />
                </div>
            </div>
        </div>
    );
}

function ResultModalHeader({ modal, onClose, onDiscuss }: {
    modal: ResultModalData;
    onClose: () => void;
    onDiscuss: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-subtle, rgba(0,0,0,0.06))',
            background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
        }}>
            <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: 'var(--bg-secondary, rgba(0,0,0,0.04))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '1px solid var(--border-subtle, rgba(0,0,0,0.08))',
                flexShrink: 0,
            }}>
                <Bot style={{ width: 18, height: 18, color: 'var(--text-primary, #0f172a)' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                    fontSize: 15, fontWeight: 700,
                    color: 'var(--text-primary, #0f172a)',
                    lineHeight: 1.3,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                    {modal.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted, #94a3b8)', fontWeight: 500, marginTop: 2 }}>
                    {modal.category === 'cowork' ? 'Cowork result' : 'Automation result'}
                </div>
            </div>
            <button
                onClick={onDiscuss}
                style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '8px 14px', borderRadius: 10,
                    fontSize: 13, fontWeight: 600,
                    border: 'none', cursor: 'pointer',
                    background: 'var(--text-primary, #0f172a)',
                    color: 'var(--bg-primary, #fff)',
                    flexShrink: 0,
                }}
            >
                {t('notifications.discuss_in_chat', '💬 Discuss in Chat')}
            </button>
            <button
                onClick={onClose}
                style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: 6, borderRadius: 8,
                    color: 'var(--text-muted, #94a3b8)',
                    flexShrink: 0,
                }}
            >
                <X style={{ width: 18, height: 18 }} />
            </button>
        </div>
    );
}

/** The panel's keyframes and the hover rule of its delete buttons. */
export function NotificationStyles() {
    return (
        <style>{`
            @keyframes notifSlideUp {
                from { opacity: 0; transform: translateY(8px) scale(0.98); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes notifSlideDown {
                from { opacity: 0; transform: translateY(-8px) scale(0.98); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes notifFadeIn {
                from { opacity: 0; transform: translateX(-4px); }
                to { opacity: 1; transform: translateX(0); }
            }
            @keyframes notifSpin { to { transform: rotate(360deg); } }
            @keyframes resultModalBgIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes resultModalIn {
                from { opacity: 0; transform: translateY(12px) scale(0.96); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            div:hover > div > .notif-delete-btn {
                opacity: 0.4 !important;
            }
        `}</style>
    );
}
