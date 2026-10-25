import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import hljs from 'highlight.js/lib/core';
import { LANG_LABELS } from './markdownRules';

const COLLAPSE_HEIGHT = 200; // px

export const CollapsibleCodeBlock = ({ className, children, ...props }: import('./MarkdownRenderer.types').CodeProps) => {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState<boolean>(false);
    const [needsCollapse, setNeedsCollapse] = useState<boolean>(false);
    const [copied, setCopied] = useState<boolean>(false);
    const codeRef = useRef<HTMLPreElement>(null);
    const measuredRef = useRef<boolean>(false);

    // Extract language from className
    const langMatch = /language-([\w-]+)/.exec(className || '');
    const language = langMatch ? langMatch[1] : '';

    // Pretty language labels
    const langLabels = LANG_LABELS;
    const displayLang = langLabels[language.toLowerCase()] || (language ? language.charAt(0).toUpperCase() + language.slice(1) : '');

    // Determine if this is a short snippet (1-2 lines, no explicit language)
    const codeText = String(children).replace(/\n$/, '');
    const lineCount = codeText.split('\n').length;
    const isCompact = lineCount <= 2 && !language;

    // Only measure once after initial render to prevent flicker
    useEffect(() => {
        if (!measuredRef.current && codeRef.current && codeRef.current.scrollHeight > COLLAPSE_HEIGHT + 40) {
            setNeedsCollapse(true);
            measuredRef.current = true;
        }
    }, []);

    // Re-measure when content changes significantly (from streaming), but debounced
    useEffect(() => {
        if (measuredRef.current) return;
        const timer = setTimeout(() => {
            if (codeRef.current && codeRef.current.scrollHeight > COLLAPSE_HEIGHT + 40) {
                setNeedsCollapse(true);
                measuredRef.current = true;
            }
        }, 500);
        return () => clearTimeout(timer);
    }, [children]);

    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(codeText).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    }, [codeText]);

    // Use a local state for highlighting to allow debouncing during streaming
    const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
    const lastHighlightText = useRef<string>('');

    useEffect(() => {
        // Skip highlighting if text hasn't changed
        if (codeText === lastHighlightText.current) return;

        // If it's a very short snippet or we are in a high-frequency update state,
        // we might want to delay the expensive highlighting.
        const debounceMs = codeText.length > 1000 ? 300 : 150;

        const timer = setTimeout(() => {
            try {
                let html = '';
                if (language && hljs.getLanguage(language)) {
                    html = hljs.highlight(codeText, { language }).value;
                } else {
                    html = hljs.highlightAuto(codeText).value;
                }
                setHighlightedHtml(html);
                lastHighlightText.current = codeText;
            } catch (err) {
                console.error('Highlight error:', err);
                setHighlightedHtml(null);
            }
        }, debounceMs);

        return () => clearTimeout(timer);
    }, [codeText, language]);

    // Compact rendering for small snippets (no header) — keep as simple inline-style
    if (isCompact) {
        return (
            <code
                className="inline-code"
                style={{ display: 'inline' }}
            >
                {codeText}
            </code>
        );
    }

    return (
        <div style={{
            borderRadius: '8px',
            overflow: 'hidden',
            margin: '0.4rem 0',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            background: '#1e1e2e',
        }}>
            {/* Header bar */}
            <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '4px 10px',
                background: 'rgba(255,255,255,0.05)',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                fontSize: '11px', fontWeight: 600,
                color: '#94a3b8',
                userSelect: 'none',
            }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <span style={{ opacity: 0.6 }}>●</span>
                    {displayLang || 'Code'}
                </span>
                <button
                    onClick={handleCopy}
                    style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: copied ? '#10b981' : '#94a3b8',
                        fontSize: '11px', fontWeight: 500,
                        display: 'flex', alignItems: 'center', gap: '3px',
                        padding: '2px 6px', borderRadius: '4px',
                        transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                    onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => e.currentTarget.style.background = 'none'}
                >
                    {copied ? (
                        <>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            {t('common.copied_short', 'Copied')}
                        </>
                    ) : (
                        <>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                            </svg>
                            {t('common.copy', 'Copy')}
                        </>
                    )}
                </button>
            </div>

            {/* Code content */}
            <div style={{ position: 'relative' }}>
                <pre ref={codeRef} className="hljs" style={{
                    maxHeight: needsCollapse && !expanded ? `${COLLAPSE_HEIGHT}px` : 'none',
                    overflow: 'auto',
                    transition: 'max-height 0.25s ease',
                    margin: 0,
                    padding: '0.6rem 0.75rem',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 0,
                    fontSize: '0.83rem',
                    lineHeight: '1.4',
                    fontFamily: "'Fira Code', 'Monaco', 'Consolas', monospace",
                }}>
                    {highlightedHtml ? (
                        <code className={className} dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
                    ) : (
                        <code className={className} {...props}>{children}</code>
                    )}
                </pre>
                {needsCollapse && !expanded && (
                    <div style={{
                        position: 'absolute', bottom: 0, left: 0, right: 0, height: '50px',
                        background: 'linear-gradient(transparent, #1e1e2e)',
                        pointerEvents: 'none',
                    }} />
                )}
            </div>
            {needsCollapse && (
                <button onClick={() => setExpanded((e: boolean) => !e)}
                    style={{
                        display: 'flex', alignItems: 'center', gap: '4px',
                        width: '100%', padding: '3px 0',
                        border: 'none', background: 'rgba(255,255,255,0.03)', cursor: 'pointer',
                        fontSize: '11px', fontWeight: 600,
                        color: 'var(--accent-primary)',
                        justifyContent: 'center',
                        borderTop: '1px solid var(--border-subtle)',
                    }}>
                    {expanded ? '▲ Show less' : '▼ Show more'}
                </button>
            )}
        </div>
    );
};
