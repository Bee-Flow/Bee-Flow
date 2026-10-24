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
import type { MermaidConfig, RenderResult } from 'mermaid';
import { Code, Eye, Maximize2, X, Download, Copy, Check, Loader2 } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import type { MermaidBlockProps, ToolbarBtnProps } from './MermaidBlock.types';

let blockCounter = 0;
/* ── Premium Theme Configuration ──────────────────────── */
const MERMAID_CONFIG: MermaidConfig = {
    startOnLoad: false,
    // Pin this explicitly. Diagram source can arrive from an ingested document
    // or an AI write, and 'loose' would let it emit click handlers and raw HTML
    // labels — we render mermaid's output with innerHTML. It is mermaid's
    // current default, but relying on a library default for a security boundary
    // is not a decision worth leaving implicit.
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
        darkMode: false,
        background: '#ffffff',
        // Core palette — calm blue-teal (Studio-aligned)
        primaryColor: '#eff6ff',
        primaryTextColor: '#1e3a8a',
        primaryBorderColor: '#3b82f6',

        secondaryColor: '#ecfdf5',
        secondaryTextColor: '#064e3b',
        secondaryBorderColor: '#34d399',

        tertiaryColor: '#f0fdf4',
        tertiaryTextColor: '#14532d',
        tertiaryBorderColor: '#86efac',

        // Edges & labels
        lineColor: '#3b82f6',
        textColor: '#1e293b',
        edgeLabelBackground: '#ffffff',

        // Flowchart nodes
        mainBkg: '#eff6ff',
        nodeBorder: '#3b82f6',
        nodeTextColor: '#1e3a8a',

        // Clusters / subgraphs
        clusterBkg: '#f0f9ff',
        clusterBorder: '#7dd3fc',

        // Title
        titleColor: '#1e3a8a',

        // Sequence diagram
        actorTextColor: '#1e3a8a',
        actorBorder: '#3b82f6',
        actorBkg: '#eff6ff',
        signalColor: '#1d4ed8',
        labelBoxBkgColor: '#eff6ff',

        // Notes
        noteBkgColor: '#fffbeb',
        noteTextColor: '#78350f',
        noteBorderColor: '#f59e0b',

        // Misc
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        fontSize: '15px',
    },
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    fontSize: 15,
    flowchart: {
        htmlLabels: true,
        curve: 'basis',
        padding: 18,
        nodeSpacing: 50,
        rankSpacing: 60,
        diagramPadding: 16,
    },
    sequence: {
        diagramMarginX: 20,
        diagramMarginY: 16,
        actorMargin: 60,
        messageMargin: 40,
        boxMargin: 8,
        boxTextMargin: 6,
        noteMargin: 12,
        mirrorActors: false,
    },
    mindmap: { padding: 20 },
    gantt: { fontSize: 13 },
};

/* ── SVG Post-Processing ──────────────────────────────── */
function postProcessSVG(svgElement: SVGSVGElement) {
    if (!svgElement) return;

    // Style: max-width responsive
    svgElement.style.maxWidth = '100%';
    svgElement.style.height = 'auto';

    // Add drop-shadow filter definition to SVG
    let defs = svgElement.querySelector('defs');
    if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        svgElement.prepend(defs);
    }

    // Premium drop-shadow filter
    if (!defs.querySelector('#premium-shadow')) {
        const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        filter.setAttribute('id', 'premium-shadow');
        filter.setAttribute('x', '-10%');
        filter.setAttribute('y', '-10%');
        filter.setAttribute('width', '130%');
        filter.setAttribute('height', '140%');
        filter.innerHTML = `
            <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(59, 130, 246, 0.15)" flood-opacity="1"/>
        `;
        defs.appendChild(filter);
    }

    // Subtle glow filter for highlighted elements
    if (!defs.querySelector('#node-glow')) {
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        glow.setAttribute('id', 'node-glow');
        glow.setAttribute('x', '-20%');
        glow.setAttribute('y', '-20%');
        glow.setAttribute('width', '150%');
        glow.setAttribute('height', '150%');
        glow.innerHTML = `
            <feGaussianBlur stdDeviation="2" result="blur"/>
            <feMerge>
                <feMergeNode in="blur"/>
                <feMergeNode in="SourceGraphic"/>
            </feMerge>
        `;
        defs.appendChild(glow);
    }

    // Apply shadows and rounded corners to nodes
    const nodeRects = svgElement.querySelectorAll<SVGElement>('.node rect, .node polygon, .node circle, .node ellipse');
    nodeRects.forEach(el => {
        el.style.filter = 'url(#premium-shadow)';
        if (el.tagName === 'rect') {
            // Soft rounded corners
            if (!el.getAttribute('rx') || parseFloat(el.getAttribute('rx') as string) < 6) {
                el.setAttribute('rx', '8');
                el.setAttribute('ry', '8');
            }
        }
    });

    // Style cluster/subgraph backgrounds
    const clusterRects = svgElement.querySelectorAll<SVGElement>('.cluster rect');
    clusterRects.forEach(el => {
        el.setAttribute('rx', '12');
        el.setAttribute('ry', '12');
        el.style.filter = 'url(#premium-shadow)';
    });

    // Thicker, smoother edge lines
    const edges = svgElement.querySelectorAll('.edge-pattern, .flowchart-link, path.path');
    edges.forEach(el => {
        const currentStrokeWidth = el.getAttribute('stroke-width');
        if (!currentStrokeWidth || parseFloat(currentStrokeWidth) < 1.8) {
            el.setAttribute('stroke-width', '1.8');
        }
    });

    // Better arrowhead markers
    const markers = svgElement.querySelectorAll<SVGElement>('marker polygon, marker path');
    markers.forEach(el => {
        if (!el.style.fill || el.style.fill === '#333') {
            el.style.fill = '#3b82f6';
        }
    });

    // Enhance edge labels
    const edgeLabels = svgElement.querySelectorAll('.edgeLabel rect, .labelBkg');
    edgeLabels.forEach(el => {
        el.setAttribute('rx', '6');
        el.setAttribute('ry', '6');
    });

    // Actor styling for sequence diagrams
    const actors = svgElement.querySelectorAll<SVGElement>('.actor');
    actors.forEach(el => {
        if (el.tagName === 'rect') {
            el.setAttribute('rx', '10');
            el.setAttribute('ry', '10');
            el.style.filter = 'url(#premium-shadow)';
        }
    });

    // Note styling for sequence diagrams
    const notes = svgElement.querySelectorAll('.note rect');
    notes.forEach(el => {
        el.setAttribute('rx', '8');
        el.setAttribute('ry', '8');
    });
}

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
                <div className="mermaid-block-header">
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
                </div>

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
