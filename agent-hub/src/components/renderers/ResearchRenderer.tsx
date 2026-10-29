import React, { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { ExternalLink, ChevronDown, ChevronRight, Lightbulb, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import type { ResearchItem, ResearchBlock, ResearchData } from './ResearchRenderer.types';

const ResearchRenderer = ({ data }: { data?: ResearchData | null }) => {
    const { t } = useTranslation();
    const [collapsedSources, setCollapsedSources] = useState(false);

    if (!data || !data.blocks) return null;

    const getFavicon = (url: string | URL) => {
        try {
            const domain = new URL(url).hostname;
            return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
        } catch {
            return null;
        }
    };

    const getDomain = (url: string | URL) => {
        try {
            return new URL(url).hostname.replace('www.', '');
        } catch {
            return String(url);
        }
    };

    const renderBlock = (block: ResearchBlock, index: string | number) => {
        if (!block || !block.type) return null;
        const key = block.id || `block-${index}`;

        switch (block.type) {
            // ====== HERO ======
            case 'hero':
                return (
                    <div key={key} className={`[position:relative] [border-radius:1rem] [overflow:hidden] [margin-bottom:1.5rem] ${block.image ? '[min-height:200px] [background:transparent]' : '[min-height:auto] [background:linear-gradient(135deg,_#1a1a2e_0%,_#16213e_50%,_#0f3460_100%)]'}`}>
                        {block.image && (
                            <>
                                <img
                                    src={block.image}
                                    alt=""
                                    className="[width:100%] [height:240px] [object-fit:cover] [display:block]"
                                />
                                <div className="[position:absolute] [inset:0] [background:linear-gradient(to_top,_rgba(0,0,0,0.85)_0%,_rgba(0,0,0,0.3)_50%,_rgba(0,0,0,0.1)_100%)]" />
                            </>
                        )}
                        <div className={`[bottom:0] [left:0] [right:0] [padding:2rem] ${block.image ? '[position:absolute]' : '[position:relative]'}`}>
                            <h1 className={`[font-size:1.75rem] [font-weight:800] [color:#fff] [margin:0] [line-height:1.2] ${block.image ? '[text-shadow:0_2px_8px_rgba(0,0,0,0.5)]' : '[text-shadow:none]'}`}>
                                {block.title || data.title}
                            </h1>
                            {block.subtitle && (
                                <p className="[font-size:1rem] [color:rgba(255,255,255,0.75)] [margin:0.5rem_0_0] [font-weight:400] [line-height:1.5]">
                                    {block.subtitle}
                                </p>
                            )}
                            {block.date && (
                                <span className="[display:inline-block] [margin-top:0.75rem] [font-size:0.75rem] [color:rgba(255,255,255,0.5)] [font-weight:500]">
                                    {block.date}
                                </span>
                            )}
                        </div>
                    </div>
                );

            // ====== MARKDOWN ======
            case 'markdown':
            case 'text':
                return (
                    <div key={key} className="[margin-bottom:1.25rem]">
                        <MarkdownRenderer content={block.content || block.text || ''} />
                    </div>
                );

            // ====== IMAGE ======
            case 'image':
                return (
                    <figure key={key} className="[margin:1.5rem_0]">
                        <img
                            src={block.src || block.url}
                            alt={block.alt || block.caption || ''}
                            style={{
                                width: '100%',
                                maxWidth: '100%',
                                height: block.height || 'auto',
                                objectFit: block.fit || 'cover',
                                borderRadius: '0.75rem',
                                boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                                display: 'block'
                            }}
                        />
                        {(block.caption || block.credit) && (
                            <figcaption className="[margin-top:0.5rem] [font-size:0.8rem] [color:var(--text-muted,_#888)] [text-align:center] [font-style:italic]">
                                {block.caption}
                                {block.credit && (
                                    <span className="[opacity:0.7]"> — {block.credit}</span>
                                )}
                            </figcaption>
                        )}
                    </figure>
                );

            // ====== SOURCES ======
            case 'sources':
                const sources = block.items || [];
                if (sources.length === 0) return null;
                return (
                    <div key={key} className="[margin-bottom:1.25rem]">
                        <button
                            onClick={() => setCollapsedSources(!collapsedSources)}
                            className="[display:flex] [align-items:center] [gap:0.5rem] [background:none] [border:none] [cursor:pointer] [font-size:0.85rem] [font-weight:600] [color:var(--text-primary,_#fff)] [padding:0.5rem_0] [margin-bottom:0.5rem]"
                        >
                            {collapsedSources
                                ? <ChevronRight className="w-4 h-4" />
                                : <ChevronDown className="w-4 h-4" />}
                            📚 {t('chat.renderers.research_sources', 'Sources ({count})', { count: sources.length })}
                        </button>
                        {!collapsedSources && (
                            <div className="[display:grid] [grid-template-columns:repeat(auto-fill,_minmax(280px,_1fr))] [gap:0.75rem]">
                                {sources.map((src, i) => (
                                    <a
                                        key={i}
                                        href={src.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="[display:flex] [align-items:center] [gap:0.75rem] [padding:0.75rem_1rem] [border-radius:0.75rem] [background:var(--bg-tertiary,_rgba(255,255,255,0.05))] [border:1px_solid_var(--border-subtle,_rgba(255,255,255,0.1))] [text-decoration:none] [transition:all_0.15s_ease] [cursor:pointer]"
                                        onMouseEnter={e => {
                                            e.currentTarget.style.background = 'var(--bg-secondary, rgba(255,255,255,0.08))';
                                            e.currentTarget.style.borderColor = 'var(--accent-primary, #6366f1)';
                                            e.currentTarget.style.transform = 'translateY(-1px)';
                                        }}
                                        onMouseLeave={e => {
                                            e.currentTarget.style.background = 'var(--bg-tertiary, rgba(255,255,255,0.05))';
                                            e.currentTarget.style.borderColor = 'var(--border-subtle, rgba(255,255,255,0.1))';
                                            e.currentTarget.style.transform = 'translateY(0)';
                                        }}
                                    >
                                        {getFavicon(src.url) && (
                                            <img
                                                src={getFavicon(src.url) as string}
                                                alt=""
                                                className="[width:20px] [height:20px] [border-radius:4px] [flex-shrink:0]"
                                                onError={e => (e.target as HTMLImageElement).style.display = 'none'}
                                            />
                                        )}
                                        <div className="[min-width:0] [flex:1]">
                                            <div className="[font-size:0.8rem] [font-weight:500] [color:var(--text-primary,_#fff)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                                                {src.title || getDomain(src.url)}
                                            </div>
                                            <div className="[font-size:0.7rem] [color:var(--text-muted,_#888)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                                                {getDomain(src.url)}
                                            </div>
                                        </div>
                                        <ExternalLink className="[width:14px] [height:14px] [color:var(--text-muted,_#888)] [flex-shrink:0]" />
                                    </a>
                                ))}
                            </div>
                        )}
                    </div>
                );

            // ====== CALLOUT ======
            case 'callout':
                const calloutStyles: Record<string, { bg: string; border: string; color: string; icon: React.JSX.Element; }> = {
                    info: { bg: 'rgba(59, 130, 246, 0.1)', border: 'rgba(59, 130, 246, 0.3)', color: '#60a5fa', icon: <Info className="w-5 h-5" /> },
                    warning: { bg: 'rgba(245, 158, 11, 0.1)', border: 'rgba(245, 158, 11, 0.3)', color: '#fbbf24', icon: <AlertTriangle className="w-5 h-5" /> },
                    success: { bg: 'rgba(16, 185, 129, 0.1)', border: 'rgba(16, 185, 129, 0.3)', color: '#34d399', icon: <CheckCircle className="w-5 h-5" /> },
                    tip: { bg: 'rgba(139, 92, 246, 0.1)', border: 'rgba(139, 92, 246, 0.3)', color: '#a78bfa', icon: <Lightbulb className="w-5 h-5" /> }
                };
                const cs = calloutStyles[block.variant as string] || calloutStyles.info;
                return (
                    <div key={key} style={{
                        display: 'flex',
                        gap: '0.75rem',
                        padding: '1rem 1.25rem',
                        borderRadius: '0.75rem',
                        background: cs.bg,
                        border: `1px solid ${cs.border}`,
                        marginBottom: '1.25rem',
                        alignItems: 'flex-start'
                    }}>
                        <div style={{ color: cs.color, flexShrink: 0, marginTop: '2px' }}>
                            {cs.icon}
                        </div>
                        <div className="[flex:1] [min-width:0]">
                            {block.title && (
                                <div style={{
                                    fontWeight: '600',
                                    fontSize: '0.9rem',
                                    color: cs.color,
                                    marginBottom: '0.25rem'
                                }}>
                                    {block.title}
                                </div>
                            )}
                            <div className="[font-size:0.85rem] [color:var(--text-secondary,_#ccc)] [line-height:1.6]">
                                {block.content || block.text}
                            </div>
                        </div>
                    </div>
                );

            // ====== STATS ======
            case 'stats':
                return (
                    <div key={key} style={{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${Math.min(block.items?.length || 3, 4)}, 1fr)`,
                        gap: '0.75rem',
                        marginBottom: '1.5rem'
                    }}>
                        {(block.items || []).map((stat, i) => (
                            <div key={i} className="[background:var(--bg-tertiary,_rgba(255,255,255,0.05))] [border-radius:0.75rem] [padding:1.25rem_1rem] [text-align:center] [border:1px_solid_var(--border-subtle,_rgba(255,255,255,0.08))]">
                                <div style={{
                                    fontSize: '1.5rem',
                                    fontWeight: '800',
                                    background: stat.color || 'linear-gradient(135deg, #8b5cf6, #6366f1)',
                                    WebkitBackgroundClip: 'text',
                                    WebkitTextFillColor: 'transparent',
                                    lineHeight: 1.2
                                }}>
                                    {stat.value}
                                </div>
                                <div className="[font-size:0.75rem] [color:var(--text-muted,_#888)] [margin-top:0.35rem] [font-weight:500] [text-transform:uppercase] [letter-spacing:0.5px]">
                                    {stat.label}
                                </div>
                            </div>
                        ))}
                    </div>
                );

            // ====== COLUMNS ======
            case 'columns':
                const colCount = block.columns || block.children?.length || 2;
                return (
                    <div key={key} style={{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${Math.min(colCount, 3)}, 1fr)`,
                        gap: block.gap || '1.25rem',
                        marginBottom: '1.25rem'
                    }}>
                        {(block.children || []).map((child, i) => (
                            <div key={i}>{renderBlock(child, `${index}-col-${i}`)}</div>
                        ))}
                    </div>
                );

            // ====== DIVIDER ======
            case 'divider':
                return (
                    <hr key={key} className="[border:none] [height:1px] [background:linear-gradient(90deg,_transparent,_var(--border-subtle,_rgba(255,255,255,0.15)),_transparent)] [margin:1.5rem_0]" />
                );

            // ====== SECTION (titled wrapper) ======
            case 'section':
                return (
                    <div key={key} className="[margin-bottom:1.5rem]">
                        {block.title && (
                            <h2 className="[font-size:1.25rem] [font-weight:700] [color:var(--text-primary,_#fff)] [margin-bottom:1rem] [padding-bottom:0.5rem] [border-bottom:2px_solid_transparent] [border-image:linear-gradient(90deg,_#8b5cf6,_#6366f1,_transparent)_1]">
                                {block.title}
                            </h2>
                        )}
                        {(block.children || block.blocks || []).map((child, i) => renderBlock(child, `${index}-sec-${i}`))}
                    </div>
                );

            default:
                // Fallback: if block has content, render as markdown
                if (block.content || block.text) {
                    return (
                        <div key={key} className="[margin-bottom:1rem]">
                            <MarkdownRenderer content={block.content || block.text} />
                        </div>
                    );
                }
                return null;
        }
    };

    return (
        <div className="[width:100%] [max-width:100%] [overflow:hidden] [white-space:normal] [font-family:var(--font-sans)] [margin:0.5rem_0] [border-radius:1rem] [background:var(--bg-primary,_#0a0a1a)] [border:1px_solid_var(--border-subtle,_rgba(255,255,255,0.08))] [padding:1.5rem] [box-sizing:border-box]">
            {/* If no hero block, show a simple title */}
            {data.title && !data.blocks.some((b: ResearchBlock) => b.type === 'hero') && (
                <h1 className="[font-size:1.5rem] [font-weight:800] [color:var(--text-primary,_#fff)] [margin-bottom:1.5rem] [padding-bottom:0.75rem] [border-bottom:2px_solid_transparent] [border-image:linear-gradient(90deg,_#8b5cf6,_#6366f1,_transparent)_1]">
                    {data.title}
                </h1>
            )}

            {data.blocks.map((block, i) => renderBlock(block, i))}
        </div>
    );
};

export default ResearchRenderer;
