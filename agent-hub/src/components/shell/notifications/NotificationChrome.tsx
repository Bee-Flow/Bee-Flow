// The bell that opens the inbox (two variants) and the result modal. Split
// out of NotificationCenter.jsx without a change in behaviour.
import { Bell, Bot, X } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
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
                <span className="[position:absolute] [top:1px] [right:1px] min-w-[14px] h-[14px] [border-radius:7px] [padding:0_3px] [background:linear-gradient(135deg,#ef4444,#dc2626)] [color:#fff] [font-size:9px] [font-weight:700] [display:flex] [align-items:center] [justify-content:center] [line-height:1] [box-shadow:0_2px_4px_rgba(220,38,38,0.3)]">
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
                <span className="[margin-left:auto] min-w-[18px] h-[18px] [border-radius:9px] [padding:0_5px] [background:linear-gradient(135deg,#ef4444,#dc2626)] [color:#fff] [font-size:10px] [font-weight:700] [display:flex] [align-items:center] [justify-content:center] [line-height:1] [box-shadow:0_2px_4px_rgba(220,38,38,0.3)]">
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
            className="[position:fixed] [inset:0] [z-index:2000] [background:rgba(0,0,0,0.5)] [backdrop-filter:blur(4px)] [display:flex] [align-items:center] [justify-content:center] [padding:24px] [animation:resultModalBgIn_0.2s_ease]"
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="w-[100%] max-w-[720px] max-h-[85vh] [background:var(--bg-card,#ffffff)] [border-radius:20px] [box-shadow:0_25px_80px_rgba(0,0,0,0.25),0_8px_24px_rgba(0,0,0,0.12)] [display:flex] [flex-direction:column] [overflow:hidden] [animation:resultModalIn_0.25s_cubic-bezier(0.16,1,0.3,1)] [border:1px_solid_var(--border-subtle,rgba(0,0,0,0.06))]"
            >
                <ResultModalHeader modal={modal} onClose={onClose} onDiscuss={onDiscuss} />

                <div className="[flex:1] [overflow-y:auto] [padding:20px_24px] [font-size:14px] [line-height:1.7] [color:var(--text-primary,#0f172a)]">
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
        <div className="[display:flex] [align-items:center] [gap:10px] [padding:16px_20px] [border-bottom:1px_solid_var(--border-subtle,rgba(0,0,0,0.06))] [background:var(--bg-secondary,rgba(0,0,0,0.02))]">
            <div className="w-[36px] h-[36px] [border-radius:10px] [background:var(--bg-secondary,rgba(0,0,0,0.04))] [display:flex] [align-items:center] [justify-content:center] [border:1px_solid_var(--border-subtle,rgba(0,0,0,0.08))] [flex-shrink:0]">
                <Bot className="w-[18px] h-[18px] [color:var(--text-primary,#0f172a)]" />
            </div>
            <div className="[flex:1] min-w-[0]">
                <div className="[font-size:15px] [font-weight:700] [color:var(--text-primary,#0f172a)] [line-height:1.3] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                    {modal.title}
                </div>
                <div className="[font-size:11px] [color:var(--text-muted,#94a3b8)] [font-weight:500] [margin-top:2px]">
                    {modal.category === 'cowork' ? 'Cowork result' : 'Automation result'}
                </div>
            </div>
            <button
                onClick={onDiscuss}
                className="[display:flex] [align-items:center] [gap:6px] [padding:8px_14px] [border-radius:10px] [font-size:13px] [font-weight:600] [border:none] [cursor:pointer] [background:var(--text-primary,#0f172a)] [color:var(--bg-primary,#fff)] [flex-shrink:0]"
            >
                {t('notifications.discuss_in_chat', '💬 Discuss in Chat')}
            </button>
            <button
                onClick={onClose}
                className="[background:none] [border:none] [cursor:pointer] [padding:6px] [border-radius:8px] [color:var(--text-muted,#94a3b8)] [flex-shrink:0]"
            >
                <X className="w-[18px] h-[18px]" />
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
