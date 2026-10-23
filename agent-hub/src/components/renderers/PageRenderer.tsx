import { useMemo, useState } from 'react';
import { renderPageElement } from './pageElementRenderers';
import type { PageElement } from './pageElementTypes';
import PageOverlay from './PageOverlay';
import type { PageOverlayState } from './PageOverlay';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * PageRenderer - Renders a page/dashboard from JSON definition
 * Supports layout, content, interactive, and data elements
 */
interface PageRendererProps {
    code: unknown;
    onAction?: (action: { type: string; action?: string; data?: unknown }) => void;
}

const PageRenderer = ({ code, onAction }: PageRendererProps) => {
    const { t } = useTranslation();
    const [overlay, setOverlay] = useState<PageOverlayState | null>(null); // { title, content, url }

    // Parse the page definition
    const pageDef = useMemo(() => {
        try {
            return typeof code === 'string' ? JSON.parse(code) : code;
        } catch {
            return null;
        }
    }, [code]);

    if (!pageDef) {
        return (
            <div className="my-4 p-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)]">
                <div className="text-red-400 text-sm">{t('chat.renderers.page_invalid', 'Invalid page definition. Expected JSON format.')}</div>
                <pre className="mt-2 text-xs overflow-auto text-[var(--text-muted)]">{code as string}</pre>
            </div>
        );
    }

    // Handle button click - show overlay
    const handleButtonClick = (element: PageElement) => {
        onAction && onAction({ type: 'button', action: element.action, data: element.data });

        // Show overlay with button info
        setOverlay({
            title: element.text || element.label || 'Info',
            content: element.overlay || element.description || element.content || `Action: ${element.action || 'click'}`,
            url: element.url || element.href,
            data: element.data
        });
    };

    // Recursive element renderer
    const ctx = {
        renderElement: (element: unknown, index = 0) => renderPageElement(element, index, ctx),
        onButtonClick: handleButtonClick,
    };
    const renderElement = ctx.renderElement;

    return (
        <div style={{
            margin: '1rem 0',
            padding: '1.5rem',
            borderRadius: '1rem',
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-subtle)',
            overflow: 'hidden',
            maxWidth: '100%',
            boxSizing: 'border-box'
        }}>
            {renderElement(pageDef)}

            {/* Overlay Modal */}
            {overlay && <PageOverlay overlay={overlay} onClose={() => setOverlay(null)} />}
        </div>
    );
};

export default PageRenderer;
