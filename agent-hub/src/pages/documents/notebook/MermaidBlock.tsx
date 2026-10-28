/**
 * MermaidBlock — Premium React component for rendering Mermaid diagrams.
 *
 * Features:
 * - Calm blue-teal theme aligned with Studio
 * - SVG post-processing: drop-shadows, rounded corners, glow effects
 * - Glassmorphism container with animated loading skeleton
 * - Fullscreen modal for large diagrams
 * - Smooth fade-in animation on render
 * - SVG export for PDF/Word
 */
import React, { useState, useRef, useEffect, useCallback, useEffectEvent } from 'react';
import mermaid from 'mermaid';
import type { RenderResult } from 'mermaid';
import { Code, Eye, Maximize2, X, Download, Copy, Check, Loader2 } from 'lucide-react';
import useTranslation, { TranslateParams } from '@/hooks/useTranslation';
import type { MermaidBlockProps, ToolbarBtnProps } from './MermaidBlock.types';
import { MERMAID_CONFIG } from './MermaidBlock.constants';
import { postProcessSVG } from './MermaidBlock.helpers';

let blockCounter = 0;

/* ── Export helpers ────────────────────────────────────── */

/**
 * Render mermaid code to SVG string (for export).
 */
export async function renderMermaidToSVG(code: string) {
    try {
        mermaid.initialize({ ...MERMAID_CONFIG, fontSize: 16 });
        const id = `mermaid-export-${Date.now()}-${blockCounter++}`;
        const { svg } = await mermaid.render(id, code.trim());
        return svg;
    } catch (err) {
        console.error('[MermaidBlock] Export render error:', err);
        return null;
    }
}

/**
 * Convert SVG string to a PNG data URL for export embedding.
 */
export function svgToPngDataUrl(svgString: string, width: number = 1200) {
    return new Promise((resolve) => {
        const img = new Image();
        const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);

        img.onload = () => {
            const canvas = document.createElement('canvas');
            const scale = width / img.width;
            canvas.width = width;
            canvas.height = img.height * scale;
            const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/png'));
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(null);
        };

        img.src = url;
    });
}

/* ── Main Component ───────────────────────────────────── */

export default function MermaidBlock({ code, onCodeChange, editable = true }: MermaidBlockProps) {
    const { t } = useTranslation();
    const [showCode, setShowCode] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ready, setReady] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [copied, setCopied] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const fullscreenContainerRef = useRef<HTMLDivElement>(null);
    const idRef = useRef(`mermaid-block-${Date.now()}-${blockCounter++}`);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Render the mermaid diagram
    const runTEffect = useEffectEvent(() => {
        if (!containerRef.current || !code?.trim() || showCode) return;

        mermaid.initialize(MERMAID_CONFIG);
        setError(null);
        setReady(false);

        const id = idRef.current;

        let cancelled = false;
        let timer: NodeJS.Timeout | null = null;
        const renderDiagram = async () => {
            const renderId = `${id}-${Date.now()}`;
            try {
                // The timeout only covers mermaid's async work. Its layout pass
                // is synchronous, so a timer can never interrupt a pathological
                // diagram — the comment here used to claim protection the code
                // could not provide. Keep it as a backstop for a hung promise
                // and make sure it is actually cleared.
                const result = await Promise.race([
                    mermaid.render(renderId, code.trim()),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Mermaid render timed out after 5 s')), 5000); }),
                ]) as RenderResult;
                if (cancelled) return;
                const { svg } = result;
                if (containerRef.current) {
                    containerRef.current.innerHTML = svg;
                    const svgEl = containerRef.current.querySelector('svg');
                    if (svgEl) {
                        postProcessSVG(svgEl);
                    }
                    setReady(true);
                }
            } catch (err) {
                if (cancelled) return;
                console.error('[MermaidBlock] Render error:', err);
                setError((err as Error).message || t('notebooks.mermaid_render_failed', 'Failed to render diagram'));
                // mermaid parks its measuring node under the id it was CALLED
                // with; cleaning up `'d' + id` targeted an id that never exists,
                // so every failed render leaked a node into <body>.
                document.getElementById(`d${renderId}`)?.remove();
                document.getElementById(renderId)?.remove();
            } finally {
                if (timer) { clearTimeout(timer); timer = null; }
            }
        };

        renderDiagram();

        return () => {
            cancelled = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (containerRef.current) {
                containerRef.current.innerHTML = '';
            }
        };
    });
    useEffect(() => { return runTEffect(); }, [code, showCode]);

    // Render fullscreen version
    useEffect(() => {
        if (!fullscreen || !fullscreenContainerRef.current || !code?.trim()) return;
        const fullscreenEl = fullscreenContainerRef.current;

        mermaid.initialize({ ...MERMAID_CONFIG, fontSize: 18 });

        const renderFullscreen = async () => {
            try {
                const renderId = `mermaid-fs-${Date.now()}-${blockCounter++}`;
                const { svg } = await mermaid.render(renderId, code.trim());
                if (fullscreenContainerRef.current) {
                    fullscreenContainerRef.current.innerHTML = svg;
                    const svgEl = fullscreenContainerRef.current.querySelector('svg');
                    if (svgEl) {
                        postProcessSVG(svgEl);
                        svgEl.style.maxHeight = '85vh';
                    }
                }
            } catch (err) {
                console.error('[MermaidBlock] Fullscreen render error:', err);
            }
        };

        renderFullscreen();

        return () => {
            fullscreenEl.innerHTML = '';
        };
    }, [fullscreen, code]);

    // Close fullscreen on Escape
    useEffect(() => {
        if (!fullscreen) return;
        const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [fullscreen]);

    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(code || '');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [code]);

    const handleDownloadSVG = useCallback(() => {
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
    }, []);

    /* ── Toolbar button helper ── */
    const ToolbarBtn = ({ onClick, title, active, children }: ToolbarBtnProps) => (
        <button
            onClick={onClick}
            title={title}
            className="mermaid-toolbar-btn"
            style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                padding: '4px 10px', borderRadius: '20px',
                background: active
                    ? 'rgba(59, 130, 246, 0.18)'
                    : 'rgba(255, 255, 255, 0.6)',
                border: `1px solid ${active ? 'rgba(59, 130, 246, 0.3)' : 'rgba(0, 0, 0, 0.06)'}`,
                color: active ? '#1d4ed8' : '#64748b',
                cursor: 'pointer', fontSize: '11px', fontWeight: 600,
                transition: 'all 0.2s ease',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
            }}
        >
            {children}
        </button>
    );

    return (
        <>
            <div
                className="notebook-mermaid-block"
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                contentEditable={false}
            >
                {/* ── Glassmorphism Header ── */}
                <MermaidBlockSection t={t} ToolbarBtn={ToolbarBtn} setShowCode={setShowCode} showCode={showCode} handleCopy={handleCopy} copied={copied} handleDownloadSVG={handleDownloadSVG} setFullscreen={setFullscreen} />

                {/* ── Code Editor ── */}
                {showCode ? (
                    <div className="[padding:14px_16px]">
                        <textarea
                            ref={textareaRef}
                            value={code || ''}
                            onChange={e => onCodeChange?.(e.target.value)}
                            readOnly={!editable}
                            spellCheck={false}
                            className="mermaid-code-editor"
                        />
                    </div>
                ) : (
                    /* ── Diagram Render Area ── */
                    <div className="mermaid-diagram-area">
                        {error ? (
                            <div className="mermaid-error">
                                <div className="[font-weight:600] [margin-bottom:4px] [display:flex] [align-items:center] [gap:6px]">
                                    <span className="[font-size:14px]">⚠️</span> {t('notebooks.mermaid_error_title', 'Diagram Error')}
                                </div>
                                <div style={{ opacity: 0.8, fontFamily: "'Fira Code', monospace", fontSize: '11px', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>
                                    {error}
                                </div>
                                <button onClick={() => setShowCode(true)} className="mermaid-error-btn">
                                    {t('notebooks.mermaid_edit_code', 'Edit Code')}
                                </button>
                            </div>
                        ) : (
                            <>
                                {/* Loading skeleton */}
                                {!ready && (
                                    <div className="mermaid-skeleton">
                                        <Loader2 size={20} className="mermaid-skeleton-spinner [animation:spin_1s_linear_infinite] [color:var(--accent-primary)]" />
                                        <span className="[font-size:12px] [color:var(--text-muted)] [margin-top:8px]">{t('notebooks.mermaid_rendering', 'Rendering diagram…')}</span>
                                    </div>
                                )}
                                <div
                                    ref={containerRef}
                                    className="mermaid-svg-container"
                                    style={{
                                        opacity: ready ? 1 : 0,
                                        transform: ready ? 'translateY(0)' : 'translateY(4px)',
                                        transition: 'opacity 0.4s ease, transform 0.4s ease',
                                    }}
                                />
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* ── Fullscreen Modal ── */}
            {fullscreen && (
                <div className="mermaid-fullscreen-overlay" onClick={() => setFullscreen(false)}>
                    <div className="mermaid-fullscreen-modal" onClick={e => e.stopPropagation()}>
                        <div className="mermaid-fullscreen-header">
                            <span className="mermaid-block-title [color:#f8fafc]">
                                <span className="mermaid-block-icon [background:rgba(59,130,246,0.3)] [color:#93c5fd]">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" />
                                    </svg>
                                </span>
                                {t('notebooks.mermaid_fullscreen_title', 'Diagram — Fullscreen')}
                            </span>
                            <div className="[display:flex] [gap:6px]">
                                <button
                                    onClick={handleDownloadSVG}
                                    className="[display:flex] [align-items:center] [gap:5px] [padding:6px_14px] [border-radius:20px] [background:rgba(255,255,255,0.08)] [border:1px_solid_rgba(255,255,255,0.12)] [color:#cbd5e1] [cursor:pointer] [font-size:12px] [font-weight:500]"
                                >
                                    <Download size={13} /> SVG
                                </button>
                                <button
                                    onClick={() => setFullscreen(false)}
                                    className="[display:flex] [align-items:center] [padding:6px_8px] [border-radius:10px] [background:rgba(255,255,255,0.08)] [border:1px_solid_rgba(255,255,255,0.12)] [color:#cbd5e1] [cursor:pointer]"
                                >
                                    <X size={16} />
                                </button>
                            </div>
                        </div>
                        <div className="mermaid-fullscreen-content">
                            <div
                                ref={fullscreenContainerRef}
                                className="w-[100%] [display:flex] [justify-content:center] [align-items:center] min-h-[300px]"
                            />
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

function MermaidBlockSection({ t, ToolbarBtn, setShowCode, showCode, handleCopy, copied, handleDownloadSVG, setFullscreen }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; ToolbarBtn: ({ onClick, title, active, children }: ToolbarBtnProps) => React.JSX.Element; setShowCode: React.Dispatch<React.SetStateAction<boolean>>; showCode: boolean; handleCopy: () => void; copied: boolean; handleDownloadSVG: () => void; setFullscreen: React.Dispatch<React.SetStateAction<boolean>>; }) {
    return <div className="mermaid-block-header">
        <span className="mermaid-block-title">
            <span className="mermaid-block-icon">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" />
                </svg>
            </span>
            {t('notebooks.mermaid_title', 'Diagram')}
        </span>

        <div className="mermaid-toolbar">
            <ToolbarBtn onClick={() => setShowCode(!showCode)} title={showCode ? t('notebooks.mermaid_show_diagram', 'Show diagram') : t('notebooks.mermaid_show_code', 'Show code')} active={showCode}>
                {showCode ? <><Eye size={12} /> {t('notebooks.mermaid_preview', 'Preview')}</> : <><Code size={12} /> {t('notebooks.mermaid_code', 'Code')}</>}
            </ToolbarBtn>

            <ToolbarBtn onClick={handleCopy} title={t('notebooks.mermaid_copy_code', 'Copy code')} active={copied}>
                {copied ? <><Check size={12} /> {t('notebooks.mermaid_copied', 'Copied')}</> : <><Copy size={12} /></>}
            </ToolbarBtn>

            {!showCode && (
                <>
                    <ToolbarBtn onClick={handleDownloadSVG} title={t('notebooks.mermaid_download_svg', 'Download SVG')}>
                        <Download size={12} />
                    </ToolbarBtn>
                    <ToolbarBtn onClick={() => setFullscreen(true)} title={t('notebooks.mermaid_fullscreen', 'Fullscreen')}>
                        <Maximize2 size={12} />
                    </ToolbarBtn>
                </>
            )}
        </div>
    </div>;
}
