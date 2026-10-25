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
            className="[position:fixed] [inset:0] [background:rgba(0,0,0,0.5)] [display:flex] [align-items:center] [justify-content:center] [z-index:9999] [backdrop-filter:blur(4px)]"
            onClick={onClose}
        >
            <div
                className="[background:var(--bg-primary)] [border-radius:1rem] [padding:1.5rem] max-w-[500px] w-[90%] max-h-[80vh] [overflow:auto] [box-shadow:0_20px_50px_rgba(0,0,0,0.3)] [border:1px_solid_var(--border-default)]"
                onClick={e => e.stopPropagation()}
            >
                <div className="[display:flex] [justify-content:space-between] [align-items:center] [margin-bottom:1rem]">
                    <h3 className="[font-size:1.25rem] [font-weight:600] [color:var(--text-primary)]">
                        {overlay.title}
                    </h3>
                    <button
                        onClick={onClose}
                        className="[background:var(--bg-tertiary)] [border:none] [border-radius:0.5rem] [padding:0.5rem] [cursor:pointer] [color:var(--text-muted)]"
                    >
                        ✕
                    </button>
                </div>

                <div className="[font-size:0.9rem] [color:var(--text-secondary)] [line-height:1.7] [word-break:break-word]">
                    {overlay.content}
                </div>

                {overlay.url && (
                    <a
                        href={overlay.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="[display:inline-block] [margin-top:1rem] [padding:0.625rem_1.25rem] [background:linear-gradient(135deg,#8b5cf6,#6366f1)] [color:white] [border-radius:0.5rem] [text-decoration:none] [font-weight:500] [font-size:0.875rem]"
                    >
                        {t('chat.renderers.page_open_link', 'Open Link →')}
                    </a>
                )}

                <button
                    onClick={onClose}
                    className="[display:block] w-[100%] [margin-top:1rem] [padding:0.75rem] [background:var(--bg-tertiary)] [border:none] [border-radius:0.5rem] [cursor:pointer] [color:var(--text-primary)] [font-weight:500]"
                >
                    {t('common.close', 'Close')}
                </button>
            </div>
        </div>
    );
}
