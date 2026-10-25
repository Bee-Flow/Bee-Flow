import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { createPortal } from 'react-dom';
import mermaid from 'mermaid';
import { Maximize2, X, Download } from 'lucide-react';
import { errorMessage, messageOf } from '../../utils/caughtError';
import { MERMAID_CONFIG } from './MermaidRenderer.constants';
let instanceCounter = 0;

/** Detect errors caused by stale Vite chunks after redeployment */
const isStaleChunkError = (err?: unknown) => {
    const msg = String(errorMessage(err) || err || '');
    return (
        msg.includes('Failed to fetch dynamically imported module') ||
        msg.includes('dynamically imported module') ||
        msg.includes('Importing a module script failed') ||
        msg.includes('error loading dynamically imported module')
    );
};

/**
 * Fullscreen overlay for Mermaid diagrams
 */
const MermaidOverlay = ({ code, onClose }: { code: string; onClose: () => void }) => {
    const { t } = useTranslation();
    const overlayRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const idRef = useRef(`mermaid-overlay-${Date.now()}-${instanceCounter++}`);

    useEffect(() => {
        if (!containerRef.current || !code?.trim()) return;

        mermaid.initialize({ ...MERMAID_CONFIG, fontSize: 16 });

        const renderDiagram = async () => {
            try {
                const { svg } = await mermaid.render(idRef.current, code.trim());
                if (containerRef.current) {
                    containerRef.current.innerHTML = svg;
                    const svgEl = containerRef.current.querySelector('svg');
                    if (svgEl) {
                        // Get the original dimensions for the viewBox
                        const origWidth = svgEl.getAttribute('width');
                        const origHeight = svgEl.getAttribute('height');
                        const viewBox = svgEl.getAttribute('viewBox');

                        // If no viewBox exists, create one from the original dimensions
                        if (!viewBox && origWidth && origHeight) {
                            const w = parseFloat(origWidth);
                            const h = parseFloat(origHeight);
                            if (w && h) {
                                svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
                            }
                        }

                        // Remove fixed dimensions so it scales to container
                        svgEl.removeAttribute('width');
                        svgEl.removeAttribute('height');
                        svgEl.style.width = '100%';
                        svgEl.style.height = 'auto';
                        svgEl.style.maxHeight = 'calc(100vh - 120px)';
                    }
                }
            } catch (err) {
                console.error('Mermaid overlay render error:', err);
                if (containerRef.current) {
                    if (isStaleChunkError(err)) {
                        containerRef.current.innerHTML = `
                            <div style="color: #94a3b8; padding: 20px; text-align: center;">
                                <div style="font-weight: 600; margin-bottom: 8px;">🔄 New version available</div>
                                <div style="margin-bottom: 12px; font-size: 13px; opacity: 0.8;">Reload the page to view this diagram.</div>
                                <button onclick="window.location.reload()" style="padding: 8px 20px; border-radius: 8px; background: rgba(99,102,241,0.2); border: 1px solid rgba(99,102,241,0.4); color: #818cf8; cursor: pointer; font-size: 13px; font-weight: 600;">Reload page</button>
                            </div>`;
                    } else {
                        containerRef.current.innerHTML = `<div style="color: #f87171; padding: 20px;">Failed to render diagram</div>`;
                    }
                }
                const errorEl = document.getElementById('d' + idRef.current);
                if (errorEl) errorEl.remove();
            }
        };

        renderDiagram();
    }, [code]);

    // Close on ESC
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    const handleDownloadSVG = () => {
        const svgEl = containerRef.current?.querySelector('svg');
        if (!svgEl) return;
        const svgData = new XMLSerializer().serializeToString(svgEl);
        const blob = new Blob([svgData], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'diagram.svg';
        a.click();
        URL.revokeObjectURL(url);
    };

    return createPortal(
        <div
            ref={overlayRef}
            onClick={(e: React.MouseEvent<HTMLDivElement>) => { if (e.target === overlayRef.current) onClose(); }}
            style={{
                position: 'fixed', inset: 0, zIndex: 9999,
                background: 'rgba(0, 0, 0, 0.85)',
                backdropFilter: 'blur(8px)',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                animation: 'mermaidOverlayIn 0.2s ease-out',
            }}
        >
            {/* Toolbar */}
            <div style={{
                position: 'absolute', top: 0, left: 0, right: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '16px 24px',
                background: 'linear-gradient(to bottom, rgba(0,0,0,0.6) 0%, transparent 100%)',
            }}>
                <span style={{
                    fontSize: '13px', fontWeight: 600,
                    color: 'rgba(255,255,255,0.6)',
                    letterSpacing: '0.05em', textTransform: 'uppercase',
                }}>
                    📊 {t('chat.renderers.mermaid_full_view', 'Diagram — Full View')}
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                        onClick={handleDownloadSVG}
                        title={t('chat.renderers.mermaid_download_svg', 'Download SVG')}
                        style={{
                            display: 'flex', alignItems: 'center', gap: '6px',
                            padding: '8px 14px', borderRadius: '8px',
                            background: 'rgba(255,255,255,0.1)',
                            border: '1px solid rgba(255,255,255,0.15)',
                            color: 'rgba(255,255,255,0.8)', cursor: 'pointer',
                            fontSize: '12px', fontWeight: 500,
                            transition: 'all 0.15s',
                        }}
                        onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { (e.target as HTMLElement).style.background = 'rgba(255,255,255,0.2)'; }}
                        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => { (e.target as HTMLElement).style.background = 'rgba(255,255,255,0.1)'; }}
                    >
                        <Download size={14} /> {t('chat.renderers.mermaid_download_svg', 'Download SVG')}
                    </button>
                    <button
                        onClick={onClose}
                        title={t('chat.renderers.mermaid_close_esc', 'Close (ESC)')}
                        style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: '36px', height: '36px', borderRadius: '8px',
                            background: 'rgba(255,255,255,0.1)',
                            border: '1px solid rgba(255,255,255,0.15)',
                            color: 'rgba(255,255,255,0.8)', cursor: 'pointer',
                            transition: 'all 0.15s',
                        }}
                        onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { (e.target as HTMLElement).style.background = 'rgba(239,68,68,0.4)'; }}
                        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => { (e.target as HTMLElement).style.background = 'rgba(255,255,255,0.1)'; }}
                    >
                        <X size={18} />
                    </button>
                </div>
            </div>

            {/* Diagram container */}
            <div
                ref={containerRef}
                style={{
                    width: '90vw', maxHeight: 'calc(100vh - 100px)',
                    overflow: 'auto', padding: '32px',
                    background: 'rgba(30, 30, 46, 0.9)',
                    borderRadius: '16px',
                    border: '1px solid rgba(255,255,255,0.08)',
                }}
            />

            <style>{`
                @keyframes mermaidOverlayIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
            `}</style>
        </div>,
        document.body
    );
};

/**
 * MermaidRenderer — renders Mermaid syntax (flowcharts, Gantt charts, sequence diagrams, etc.)
 * as an interactive SVG with dark theme styling consistent with the app.
 */
const MermaidRenderer = ({ code }: { code: string }) => {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [ready, setReady] = useState<boolean>(false);
    const [showOverlay, setShowOverlay] = useState<boolean>(false);
    const [hovered, setHovered] = useState<boolean>(false);
    const idRef = useRef(`mermaid-${Date.now()}-${instanceCounter++}`);

    const initMermaid = useCallback(() => {
        mermaid.initialize(MERMAID_CONFIG);
    }, []);

    useEffect(() => {
        if (!containerRef.current || !code?.trim()) return;

        initMermaid();
        setError(null);
        setReady(false);

        const id = idRef.current;

        const renderDiagram = async () => {
            try {
                const { svg } = await mermaid.render(id, code.trim());
                if (containerRef.current) {
                    containerRef.current.innerHTML = svg;
                    // Make SVG responsive
                    const svgEl = containerRef.current.querySelector('svg');
                    if (svgEl) {
                        svgEl.style.maxWidth = '100%';
                        svgEl.style.height = 'auto';
                    }
                    setReady(true);
                }
            } catch (err) {
                console.error('Mermaid render error:', err);
                if (isStaleChunkError(err)) {
                    setError('__STALE_CHUNK__');
                } else {
                    setError(messageOf(err, 'Failed to render diagram'));
                }
                // Clean up any error elements mermaid may have injected
                const errorEl = document.getElementById('d' + id);
                if (errorEl) errorEl.remove();
            }
        };

        renderDiagram();

        return () => {
            if (containerRef.current) {
                containerRef.current.innerHTML = '';
            }
        };
    }, [code, initMermaid]);

    if (error) {
        // Stale Vite chunk — show friendly reload prompt
        if (error === '__STALE_CHUNK__') {
            return (
                <div style={{
                    padding: '16px 20px',
                    borderRadius: '10px',
                    background: 'var(--bg-tertiary, #1e1e2e)',
                    border: '1px solid rgba(99, 102, 241, 0.3)',
                    color: 'var(--text-secondary, #94a3b8)',
                    fontSize: '13px',
                    margin: '8px 0',
                    textAlign: 'center',
                }}>
                    <div style={{ fontWeight: 600, marginBottom: '6px' }}>🔄 {t('chat.renderers.mermaid_new_version', 'New version available')}</div>
                    <div style={{ opacity: 0.8, marginBottom: '12px' }}>{t('chat.renderers.mermaid_reload_hint', 'Reload the page to view this diagram.')}</div>
                    <button
                        onClick={() => window.location.reload()}
                        style={{
                            padding: '8px 20px',
                            borderRadius: '8px',
                            background: 'rgba(99, 102, 241, 0.15)',
                            border: '1px solid rgba(99, 102, 241, 0.4)',
                            color: '#818cf8',
                            cursor: 'pointer',
                            fontSize: '13px',
                            fontWeight: 600,
                            transition: 'all 0.15s',
                        }}
                    >
                        {t('chat.renderers.mermaid_reload', 'Reload page')}
                    </button>
                </div>
            );
        }

        return (
            <div style={{
                padding: '12px 16px',
                borderRadius: '10px',
                background: 'var(--bg-tertiary, #1e1e2e)',
                border: '1px solid var(--error)',
                color: 'var(--error)',
                fontSize: '13px',
                margin: '8px 0',
            }}>
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>⚠️ {t('chat.renderers.mermaid_error', 'Diagram Error')}</div>
                <div style={{ opacity: 0.8, fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>{error}</div>
            </div>
        );
    }

    return (
        <>
            <div
                style={{
                    margin: '12px 0',
                    borderRadius: '12px',
                    border: '1px solid var(--border-subtle, #2a2a3e)',
                    background: 'var(--bg-tertiary, #1e1e2e)',
                    overflow: 'hidden',
                    whiteSpace: 'normal',
                    fontFamily: 'var(--font-sans)',
                    padding: '20px',
                    opacity: ready ? 1 : 0,
                    transition: 'opacity 0.35s ease',
                    textAlign: 'center',
                    position: 'relative',
                    cursor: 'pointer',
                }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onClick={() => setShowOverlay(true)}
            >
                {/* Expand button */}
                <button
                    onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); setShowOverlay(true); }}
                    title={t('chat.renderers.mermaid_open_full', 'Open full view')}
                    style={{
                        position: 'absolute', top: '10px', right: '10px',
                        display: 'flex', alignItems: 'center', gap: '5px',
                        padding: '6px 10px', borderRadius: '8px',
                        background: hovered ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255,255,255,0.06)',
                        border: '1px solid',
                        borderColor: hovered ? 'rgba(99, 102, 241, 0.4)' : 'rgba(255,255,255,0.08)',
                        color: hovered ? '#818cf8' : 'var(--text-muted, #888)',
                        cursor: 'pointer', fontSize: '11px', fontWeight: 600,
                        transition: 'all 0.2s ease',
                        zIndex: 2, opacity: hovered ? 1 : 0,
                    }}
                >
                    <Maximize2 size={13} /> {t('chat.renderers.mermaid_expand', 'Expand')}
                </button>

                <div
                    ref={containerRef}
                    style={{
                        width: '100%',
                        minHeight: '80px',
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                    }}
                />
            </div>

            {/* Fullscreen overlay */}
            {showOverlay && (
                <MermaidOverlay code={code} onClose={() => setShowOverlay(false)} />
            )}
        </>
    );
};

export default React.memo(MermaidRenderer);
