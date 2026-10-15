import type { ReactNode } from 'react';
import { useTranslation } from '../../hooks/useTranslation';

export interface PageOverlayState {
    title: ReactNode;
    content: ReactNode;
    url?: string;
    data?: unknown;
}

interface PageOverlayProps {
    overlay: PageOverlayState;
    onClose: () => void;
}

/** Modal shown after a page button was clicked. */
export default function PageOverlay({ overlay, onClose }: PageOverlayProps) {
    const { t } = useTranslation();
    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 9999,
                backdropFilter: 'blur(4px)'
            }}
            onClick={onClose}
        >
            <div
                style={{
                    background: 'var(--bg-primary)',
                    borderRadius: '1rem',
                    padding: '1.5rem',
                    maxWidth: '500px',
                    width: '90%',
                    maxHeight: '80vh',
                    overflow: 'auto',
                    boxShadow: '0 20px 50px rgba(0,0,0,0.3)',
                    border: '1px solid var(--border-default)'
                }}
                onClick={e => e.stopPropagation()}
            >
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '1rem'
                }}>
                    <h3 style={{
                        fontSize: '1.25rem',
                        fontWeight: '600',
                        color: 'var(--text-primary)'
                    }}>
                        {overlay.title}
                    </h3>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'var(--bg-tertiary)',
                            border: 'none',
                            borderRadius: '0.5rem',
                            padding: '0.5rem',
                            cursor: 'pointer',
                            color: 'var(--text-muted)'
                        }}
                    >
                        ✕
                    </button>
                </div>

                <div style={{
                    fontSize: '0.9rem',
                    color: 'var(--text-secondary)',
                    lineHeight: '1.7',
                    wordBreak: 'break-word'
                }}>
                    {overlay.content}
                </div>

                {overlay.url && (
                    <a
                        href={overlay.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                            display: 'inline-block',
                            marginTop: '1rem',
                            padding: '0.625rem 1.25rem',
                            background: 'linear-gradient(135deg, #8b5cf6, #6366f1)',
                            color: 'white',
                            borderRadius: '0.5rem',
                            textDecoration: 'none',
                            fontWeight: '500',
                            fontSize: '0.875rem'
                        }}
                    >
                        {t('chat.renderers.page_open_link', 'Open Link →')}
                    </a>
                )}

                <button
                    onClick={onClose}
                    style={{
                        display: 'block',
                        width: '100%',
                        marginTop: '1rem',
                        padding: '0.75rem',
                        background: 'var(--bg-tertiary)',
                        border: 'none',
                        borderRadius: '0.5rem',
                        cursor: 'pointer',
                        color: 'var(--text-primary)',
                        fontWeight: '500'
                    }}
                >
                    {t('common.close', 'Close')}
                </button>
            </div>
        </div>
    );
}
