import { Copy, Check, ChevronDown, ThumbsUp, ThumbsDown, RefreshCw, Download, FileText } from 'lucide-react';
import ReactDOM from 'react-dom';
import useTranslation from '../../../hooks/useTranslation';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';
import { TIER_META } from '../../licensing/tierMeta';

/**
 * Assistant-message action bar (copy/export, feedback thumbs, retry) plus the
 * right-hand timestamp. Lifted verbatim out of MessageItem/index.jsx — every
 * piece of state and every ref still lives in MessageItem and is threaded down
 * as props.
 */

const RetryTierMenu = ({ idx, onRetry, setShowRetryMenu, retryMenuRef, retryMenuPos, modelTiers, t }) => {
    // Reuse TIER_META so the retry menu picks up the same
    // lucide icons and labels as the composer's tier picker.
    const RETRY_KEYS = ['auto', 'fast', 'thinking', 'writer', 'pro'];
    const RETRY_TIERS = Object.fromEntries(
        RETRY_KEYS.map(k => [k, TIER_META[k]]).filter(([, m]) => m)
    );
    return ReactDOM.createPortal(
        <div
            ref={retryMenuRef}
            className="rounded-xl shadow-2xl z-[9999] animate-fade-in"
            style={{
                position: 'fixed',
                top: retryMenuPos.top,
                left: retryMenuPos.left,
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-default)',
                minWidth: '220px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                overflow: 'hidden',
            }}
        >
            <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">{t('chat.msg.retry_with_model', 'Retry with model')}</span>
            </div>
            {Object.entries(RETRY_TIERS).map(([key, meta]) => {
                const isConfigured = key === 'auto' || !!modelTiers[key]?.modelId;
                if (!isConfigured) return null;
                return (
                    <button
                        key={key}
                        onClick={() => { onRetry(idx, key); setShowRetryMenu(false); }}
                        className="w-full text-left px-3 py-2.5 transition-colors flex items-center gap-2.5 hover:bg-[var(--bg-tertiary)]"
                    >
                        <span className="w-6 flex items-center justify-center flex-shrink-0">
                            {meta.iconSrc ? (
                                <img src={meta.iconSrc} alt="" className="w-4 h-4 object-contain" />
                            ) : meta.Icon ? (
                                <meta.Icon className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
                            ) : (
                                <span className="text-lg">{meta.emoji}</span>
                            )}
                        </span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-semibold text-[var(--text-primary)]">{meta.label}</div>
                            <div className="text-[11px] text-[var(--text-tertiary)]">
                                {meta.desc}
                            </div>
                        </div>
                    </button>
                );
            })}
        </div>,
        document.body
    );
};

/**
 * The status next to the timestamp of a turn that ended in an error. A turn
 * that failed AFTER some of its tools ran was not a failed send: the message
 * went out and those actions happened (BFSF-349), so it says how far it got,
 * and only the error itself decides the tone.
 */
const ErrorStatus = ({ msg, t }) => {
    const afterActions = msg.completedToolCount > 0;
    const text = afterActions && typeof msg.errorDetail === 'string' ? msg.errorDetail : msg.content;
    const usage = text?.includes('limit') || text?.includes('subscription');
    const account = usage || text?.includes('suspended') || text?.includes('cancelled');
    let label;
    if (afterActions) {
        label = nOf(t, 'chat.msg.stopped_after_actions', msg.completedToolCount, 'Stopped after 1 action', 'Stopped after {count} actions');
    } else {
        label = account ? t('chat.msg.usage_limit', 'Usage limit reached') : t('chat.msg.send_failed', 'Failed to send');
    }
    return (
        <span className={`font-medium flex items-center gap-1 ${account ? 'text-amber-500' : 'text-red-500'}`} data-testid="msg-error-status">
            <span className={`w-1.5 h-1.5 rounded-full ${usage ? 'bg-amber-500' : 'bg-red-500'}`}></span> {label}
        </span>
    );
};

const MessageActionsRow = ({
    msg,
    idx,
    allowCopy,
    copyMenuRef,
    copied,
    copiedMd,
    handleCopy,
    handleCopyMarkdown,
    handleExportPdf,
    showCopyMenu,
    setShowCopyMenu,
    feedbackRating,
    feedbackSubmitted,
    handleThumbClick,
    onRetry,
    retryMenuRef,
    retryBtnRef,
    handleToggleRetryMenu,
    showRetryMenu,
    setShowRetryMenu,
    retryMenuPos,
    modelTiers,
}) => {
    const { t } = useTranslation();
    return (
    <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1">
            {/* Copy / Export dropdown */}
            {allowCopy && (
                <div className="relative" ref={copyMenuRef}>
                    <button
                        onClick={() => {
                            // Quick action: copy on click
                            handleCopy();
                        }}
                        className="p-1.5 hover:bg-[var(--bg-tertiary)] rounded text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                        title={t('chat.copy', 'Copy')}
                        data-testid="msg-copy-btn"
                    >
                        {copied || copiedMd ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    {msg.content && (
                        <button
                            onClick={() => setShowCopyMenu(!showCopyMenu)}
                            className="p-0.5 -ml-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                            title={t('chat.msg.more_export', 'More export options')}
                            data-testid="msg-copy-more-btn"
                        >
                            <ChevronDown className="w-3 h-3" />
                        </button>
                    )}
                    {showCopyMenu && (
                        <div className="absolute bottom-full left-0 mb-1 rounded-lg shadow-xl overflow-hidden z-[100] animate-fade-in"
                            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)', minWidth: '160px', boxShadow: '0 4px 16px rgba(0,0,0,0.2)' }}
                        >
                            <button
                                onClick={() => { handleCopy(); setShowCopyMenu(false); }}
                                className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-[var(--bg-tertiary)] transition-colors"
                                style={{ color: 'var(--text-primary)' }}
                                data-testid="msg-copy-btn-menu"
                            >
                                <Copy className="w-3.5 h-3.5 opacity-60" />
                                {t('chat.copy', 'Copy')}
                            </button>
                            <button
                                onClick={() => { handleCopyMarkdown(); setShowCopyMenu(false); }}
                                className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-[var(--bg-tertiary)] transition-colors"
                                style={{ color: 'var(--text-primary)' }}
                                data-testid="msg-copy-md-btn"
                            >
                                <FileText className="w-3.5 h-3.5 opacity-60" />
                                {t('chat.copy_markdown', 'Copy as Markdown')}
                            </button>
                            <div style={{ height: '1px', background: 'var(--border-subtle)' }} />
                            <button
                                onClick={() => { handleExportPdf(); setShowCopyMenu(false); }}
                                className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-[var(--bg-tertiary)] transition-colors"
                                style={{ color: 'var(--text-primary)' }}
                                data-testid="msg-export-pdf-btn"
                            >
                                <Download className="w-3.5 h-3.5 opacity-60" />
                                {t('chat.msg.export_pdf', 'Export as PDF')}
                            </button>
                        </div>
                    )}
                </div>
            )}
            {/* Thumbs feedback */}
            <button
                onClick={() => handleThumbClick('up')}
                className={`p-1.5 rounded transition-colors ${feedbackRating === 'up' ? 'text-green-500 bg-green-500/10' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
                title={t('chat.msg.thumbs_up', 'Good response')}
                data-testid="msg-thumbs-up"
            >
                <ThumbsUp className="w-3.5 h-3.5" />
            </button>
            <button
                onClick={() => handleThumbClick('down')}
                className={`p-1.5 rounded transition-colors ${feedbackRating === 'down' ? 'text-red-500 bg-red-500/10' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
                title={t('chat.msg.thumbs_down', 'Bad response')}
                data-testid="msg-thumbs-down"
            >
                <ThumbsDown className="w-3.5 h-3.5" />
            </button>
            {feedbackSubmitted && (
                <span className="text-[10px] text-green-500 ml-1 font-medium">{t('chat.msg.feedback_thanks', 'Thanks!')}</span>
            )}

            {/* Retry button */}
            {onRetry && (
                <div className="relative ml-1" ref={retryMenuRef}>
                    <div className="flex items-center">
                        <button
                            onClick={() => onRetry(idx)}
                            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                            title={t('chat.msg.retry', 'Retry response')}
                            data-testid="msg-retry-btn"
                        >
                            <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                        <button
                            ref={retryBtnRef}
                            onClick={handleToggleRetryMenu}
                            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors -ml-1"
                            title={t('chat.msg.retry_other_model', 'Retry with different model')}
                        >
                            <ChevronDown className="w-3 h-3" />
                        </button>
                    </div>
                    {showRetryMenu && (
                        <RetryTierMenu
                            idx={idx}
                            onRetry={onRetry}
                            setShowRetryMenu={setShowRetryMenu}
                            retryMenuRef={retryMenuRef}
                            retryMenuPos={retryMenuPos}
                            modelTiers={modelTiers}
                            t={t}
                        />
                    )}
                </div>
            )}
        </div>
        {/* Timestamp — right side */}
        <div className="text-[10px] text-[var(--text-tertiary)] flex items-center gap-1">
            {msg.isError && <ErrorStatus msg={msg} t={t} />}
            {msg.timestamp && (
                <span className="opacity-70">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            )}
        </div>
    </div>
    );
};

export default MessageActionsRow;
