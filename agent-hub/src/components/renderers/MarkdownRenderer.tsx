import React, { Suspense, lazy, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from '../../hooks/useTranslation';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import markdown from 'highlight.js/lib/languages/markdown';
import 'highlight.js/styles/github-dark.min.css';
import PageRenderer from './PageRenderer';
import { logger } from '../../utils/logger';
import ResearchRenderer from './ResearchRenderer';
import TestReportRenderer from './TestReportRenderer';
const VegaLiteRenderer = lazy(() => import('./VegaLiteRenderer'));
import MapEmbedRenderer from './MapEmbedRenderer';
const MermaidRenderer = lazy(() => import('./MermaidRenderer'));
import WebpageLinkCard from '../webpages/WebpageLinkCard';
import DocumentLinkCard from '../documents/DocumentLinkCard';
import { DOCUMENT_CARD, LANG_LABELS, WEBPAGE_CARD, WRAPPING_FENCE_CLOSE, WRAPPING_FENCE_OPEN, anchorKey, headingSlug, stripDirectiveBlocks } from './markdownRules';

/**
 * Inline loading placeholder shown while a special ```json-*``` block is still
 * streaming or its JSON is incomplete. Extracted from the ~13 identical copies
 * that differed only by their label text.
 */
const BlockLoading = ({ label }: { label: string }) => (
    <div className="my-2 flex items-center gap-3 p-4 rounded-xl bg-[var(--bg-tertiary)]">
        <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin [border-color:var(--accent-primary)]! [border-top-color:transparent]!" />
        <span className="text-sm text-[var(--text-muted)]">{label}</span>
    </div>
);

// Register languages
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('java', java);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', cpp);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rb', ruby);
hljs.registerLanguage('php', php);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);

// Code block with language header, copy button, and optional collapsing
// BFSF-273: react-markdown v9 removed the `inline` prop this renderer's code
// component destructured — it was silently undefined ever since the v10
// upgrade, routing EVERY code span (single-backtick inline included) through
// CollapsibleCodeBlock (5 hooks + hljs + measurement timers per token). The
// v10 way to tell them apart is nesting: fenced blocks arrive wrapped in a
// <pre>, inline code does not. The `pre` override below provides this context.
const PreContext = React.createContext(false);

const COLLAPSE_HEIGHT = 200; // px
const CollapsibleCodeBlock = ({ className, children, ...props }: import('./MarkdownRenderer.types').CodeProps) => {
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
                className="inline-code [display:inline]"
            >
                {codeText}
            </code>
        );
    }

    return (
        <div className="[border-radius:8px] [overflow:hidden] [margin:0.4rem_0] [border:1px_solid_rgba(255,255,255,0.08)] [background:#1e1e2e]">
            {/* Header bar */}
            <div className="[display:flex] [align-items:center] [justify-content:space-between] [padding:4px_10px] [background:rgba(255,255,255,0.05)] [border-bottom:1px_solid_rgba(255,255,255,0.06)] [font-size:11px] [font-weight:600] [color:#94a3b8] [user-select:none]">
                <span className="[display:flex] [align-items:center] [gap:5px]">
                    <span className="[opacity:0.6]">●</span>
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
            <div className="[position:relative]">
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
                    <div className="[position:absolute] [bottom:0] [left:0] [right:0] h-[50px] [background:linear-gradient(transparent,#1e1e2e)] [pointer-events:none]" />
                )}
            </div>
            {needsCollapse && (
                <button onClick={() => setExpanded((e: boolean) => !e)}
                    className="[display:flex] [align-items:center] [gap:4px] w-[100%] [padding:3px_0] [border:none] [background:rgba(255,255,255,0.03)] [cursor:pointer] [font-size:11px] [font-weight:600] [color:var(--accent-primary)] [justify-content:center] [border-top:1px_solid_var(--border-subtle)]">
                    {expanded ? '▲ Show less' : '▼ Show more'}
                </button>
            )}
        </div>
    );
};

/**
 * Renderer for every fenced/inline code span in a message.
 *
 * A real, PascalCase component rather than an inline `code() {}` entry in the
 * `components` map. It reads PreContext to tell a block from an inline span, and
 * a hook inside a lowercase render function is exactly what
 * react-hooks/rules-of-hooks forbids — the rule cannot know react-markdown mounts
 * those entries as components. Hoisting it out makes the hook legal on its own
 * terms instead of asking for an exemption.
 *
 * `isLoading` is threaded in as a prop: while a message is still streaming, a
 * half-written JSON block must show a placeholder rather than fail to parse.
 */
const CodeRenderer = ({ node, className, children, isLoading = false, ...props }: import('./MarkdownRenderer.types').CodeRendererProps) => {
    // `pre` wraps fenced/indented code in a PreContext provider, so an absent
    // context means this span is inline.
    const inline = !React.useContext(PreContext);
    // Match language tag including hyphens (e.g., html-app)
    const match = /language-([\w-]+)/.exec(className || '');
    const language = match ? match[1] : '';
    const codeString = String(children).replace(/\n$/, '');

    // Workspace blocks are no longer rendered inline — workspace content
    // is handled via workspace_write tool calls and the WorkspacePanel.
    const isWorkspace = language === 'workspace' ||
        language === 'workspace-selection' ||
        (className || '').includes('language-workspace') ||
        (className || '').includes('language-workspace-selection');

    if (!inline && isWorkspace) {
        return null; // Hidden — workspace tool handles display
    }

    // Check if this is a page code block
    const isPage = language === 'json-page' ||
        language === 'page' ||
        language === 'page-json';

    if (!inline && isPage) {
        if (isLoading) {
            return (
                <BlockLoading label="Creating page..." />
            );
        }
        try {
            JSON.parse(codeString);
            return (
                <div className="w-[100%] max-w-[100%] [overflow:hidden] [white-space:normal] [font-family:var(--font-sans)]">
                    <PageRenderer
                        code={codeString}
                        // Stub handler: page actions have no chat-side behavior yet;
                        // trace them in dev so authors can see the action payload.
                        onAction={(action: { type: string; action?: string }) => logger.debug('Page action:', action)}
                    />
                </div>
            );
        } catch {
            // Page JSON is incomplete - show loading indicator
            return (
                <BlockLoading label="Creating page..." />
            );
        }
    }

    // Check if this is a research code block
    const isResearch = language === 'json-research' ||
        language === 'research' ||
        language === 'research-json';

    if (!inline && isResearch) {
        if (isLoading) {
            return (
                <BlockLoading label="Building research report..." />
            );
        }
        try {
            const researchData = JSON.parse(codeString);
            return (
                <div className="w-[100%] max-w-[100%] [overflow:hidden] [white-space:normal] [font-family:var(--font-sans)]">
                    <ResearchRenderer data={researchData} />
                </div>
            );
        } catch {
            return (
                <BlockLoading label="Building research report..." />
            );
        }
    }

    // Check if this is a test report code block
    const isTestReport = language === 'json-test-report' ||
        language === 'test-report' ||
        language === 'test-report-json';

    if (!inline && isTestReport) {
        if (isLoading) {
            return (
                <BlockLoading label="Building test report..." />
            );
        }
        try {
            const testData = JSON.parse(codeString);
            return (
                <div className="w-[100%] max-w-[100%] [overflow:hidden] [white-space:normal] [font-family:var(--font-sans)]">
                    <TestReportRenderer data={testData} />
                </div>
            );
        } catch {
            return (
                <BlockLoading label="Building test report..." />
            );
        }
    }

    // Check if this is a Vega-Lite chart code block
    const isVegaLite = language === 'vega-lite' ||
        language === 'vegalite' ||
        language === 'vega';

    if (!inline && isVegaLite) {
        // While still streaming, always show loading — don't attempt partial renders
        if (isLoading) {
            return (
                <BlockLoading label="Rendering chart..." />
            );
        }
        try {
            JSON.parse(codeString);
            return (
                <div className="w-[100%] max-w-[100%] [overflow:visible] [white-space:normal] [font-family:var(--font-sans)]">
                    <Suspense fallback={null}><VegaLiteRenderer spec={codeString} /></Suspense>
                </div>
            );
        } catch {
            // Vega-Lite JSON is incomplete - show loading
            return (
                <BlockLoading label="Rendering chart..." />
            );
        }
    }

    // Check if this is a Mermaid diagram code block
    const isMermaid = language === 'mermaid';

    if (!inline && isMermaid) {
        if (isLoading) {
            return (
                <BlockLoading label="Rendering diagram..." />
            );
        }
        return (
            <div className="w-[100%] max-w-[100%] [overflow:visible] [white-space:normal] [font-family:var(--font-sans)]">
                <Suspense fallback={null}><MermaidRenderer code={codeString} /></Suspense>
            </div>
        );
    }

    // Check if this is a map embed code block
    const isMapEmbed = language === 'map-embed' ||
        language === 'map' ||
        language === 'maps';

    if (!inline && isMapEmbed) {
        if (isLoading) {
            return (
                <BlockLoading label="Loading map..." />
            );
        }
        try {
            const mapData = JSON.parse(codeString);
            return (
                <div className="w-[100%] max-w-[100%] [overflow:hidden] [white-space:normal] [font-family:var(--font-sans)]">
                    <MapEmbedRenderer
                        embedUrl={mapData.embedUrl}
                        title={mapData.title || 'Map'}
                        mapsLink={mapData.mapsLink}
                    />
                </div>
            );
        } catch {
            return (
                <BlockLoading label="Loading map..." />
            );
        }
    }

    return inline ? (
        <code className="inline-code" {...props}>
            {children}
        </code>
    ) : (
        <CollapsibleCodeBlock className={className} {...props}>
            {children}
        </CollapsibleCodeBlock>
    );
};

// What `inline` keeps: the marks a short line of prose carries. Everything else
// (lists, headings, quotes, fences, tables, images) is unwrapped to its text, so
// a question prompt or a plan line can show **bold**, `code` and a link without
// growing a block of its own inside a card.
const INLINE_ELEMENTS = ['strong', 'em', 'del', 'code', 'a', 'br'];

const MarkdownRenderer = ({ content, className = '', isLoading = false, inline = false, ...props }: import('./MarkdownRenderer.types').MarkdownRendererProps) => {
    // Throttle content updates to prevent flickering during streaming
    const THROTTLE_MS = 150;
    const [renderContent, setRenderContent] = useState<import('./MarkdownRenderer.types').MarkdownContent | null | undefined>(content);
    const [firstUpdateAt] = useState(() => Date.now());
    const lastUpdateRef = useRef(firstUpdateAt);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const now = Date.now();
        const elapsed = now - lastUpdateRef.current;

        if (elapsed >= THROTTLE_MS) {
            setRenderContent(content);
            lastUpdateRef.current = now;
        } else {
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
                setRenderContent(content);
                lastUpdateRef.current = Date.now();
            }, THROTTLE_MS - elapsed);
        }

        return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    }, [content]);

    // Handle null/undefined/non-string content
    if (!renderContent) return null;

    // Ensure content is a string - handle multimodal format or objects
    let textContent = renderContent;
    if (typeof renderContent !== 'string') {
        if (Array.isArray(renderContent)) {
            // Multimodal array format - extract text
            const textBlock = renderContent.find((b: import('./MarkdownRenderer.types').MarkdownContentPart) => b.type === 'text');
            textContent = textBlock?.text || '';
        } else if (typeof renderContent === 'object') {
            // Object format - try to stringify or extract text
            textContent = renderContent.text || JSON.stringify(renderContent);
        } else {
            textContent = String(renderContent);
        }
    }

    if (!textContent) return null;

    // Detect unclosed code blocks for specific languages and extract partial code
    const detectUnclosedCodeBlock = (text: string): null => {
        // Guard: ensure text is a string
        if (typeof text !== 'string') return null;

        // html-app blocks are no longer used — the Webpages feature replaced them.
        return null;
    };

    // Detect and strip wrapping code blocks (to handle streaming/partial content)
    const stripWrappingCodeBlock = (text: string): string => {
        if (typeof text !== 'string') return text;

        let cleaned = text;

        // 1. Remove opening fence (greedy, handles partial stream)
        // Match start of string, with optional leading whitespace
        const startMatch = cleaned.match(WRAPPING_FENCE_OPEN);
        if (startMatch) {
            cleaned = cleaned.substring(startMatch[0].length);
        }

        // 2. Remove closing fence (if present at end)
        // Match newline + ``` + optional trailing whitespace
        const endMatch = cleaned.match(WRAPPING_FENCE_CLOSE);
        if (endMatch) {
            cleaned = cleaned.substring(0, endMatch.index);
        }

        return cleaned;
    };

    // :::directive blocks (e.g. :::writing Title) from newer GPT models are stripped by markdownRules.
    const cleanContent = stripDirectiveBlocks(stripWrappingCodeBlock(textContent as string));

    const unclosedBlock = detectUnclosedCodeBlock(cleanContent);

    const Wrapper = inline ? 'span' : 'div';
    return (
        <Wrapper className={`markdown-content ${className}`}>
            <ReactMarkdown
                remarkPlugins={inline ? [remarkGfm] : [remarkGfm, remarkMath]}
                rehypePlugins={inline ? [] : [rehypeKatex]}
                {...(inline ? { allowedElements: INLINE_ELEMENTS, unwrapDisallowed: true } : {})}
                components={{
                    // Fenced/indented code arrives wrapped in a <pre>; mark the
                    // subtree so the code component can tell block from inline
                    // (see PreContext note above).
                    pre({ node, children, ...props }) {
                        return (
                            <PreContext.Provider value={true}>
                                <pre {...props}>{children}</pre>
                            </PreContext.Provider>
                        );
                    },
                    // Code blocks with syntax highlighting style
                    // Delegates to the hoisted CodeRenderer so its useContext call
                    // lives in a properly-named component (see the note there).
                    code: (codeProps) => <CodeRenderer {...codeProps} isLoading={isLoading} />,
                    // Links — anchor links scroll within message, external open in new tab
                    a({ node, children, href, ...props }) {
                        // Webpage links render as a clickable card instead of a plain anchor
                        if (href && WEBPAGE_CARD.test(href)) {
                            const label = typeof children === 'string' ? children : (Array.isArray(children) ? children.join('') : String(href));
                            return <WebpageLinkCard href={href} label={label} />;
                        }
                        // Document links do the same — the model is told to end
                        // its reply with "[<name>](<url>)" after building one.
                        if (href && DOCUMENT_CARD.test(href)) {
                            const label = typeof children === 'string' ? children : (Array.isArray(children) ? children.join('') : String(href));
                            return <DocumentLinkCard href={href} label={label} />;
                        }
                        if (href && href.startsWith('#')) {
                            return (
                                <a
                                    href={href}
                                    onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
                                        e.preventDefault();
                                        const fragment = anchorKey(href.slice(1));
                                        const container = e.currentTarget.closest('.markdown-content');
                                        if (!container) return;

                                        // Try exact ID match first
                                        let target = container.querySelector(`[id="${href.slice(1)}"]`);

                                        // Fuzzy: search all headings and compare normalized text
                                        if (!target) {
                                            const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
                                            for (const h of headings) {
                                                const hText = anchorKey(h.textContent || '');
                                                if (hText.includes(fragment) || fragment.includes(hText)) {
                                                    target = h;
                                                    break;
                                                }
                                            }
                                        }

                                        if (target) {
                                            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                        }
                                    }}
                                    {...props}
                                >
                                    {children}
                                </a>
                            );
                        }
                        return (
                            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                                {children}
                            </a>
                        );
                    },
                    // Headings with auto-generated IDs for anchor links (table of contents)
                    ...(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].reduce((acc: Record<string, React.ComponentType<import('./MarkdownRenderer.types').HeadingProps>>, tag: string) => {
                        acc[tag] = ({ node, children, ...hProps }: import('./MarkdownRenderer.types').HeadingProps) => {
                            const extractText = (child: React.ReactNode): string => {
                                if (typeof child === 'string') return child;
                                if ((child as React.ReactElement<{ children?: React.ReactNode }>)?.props?.children) {
                                    return React.Children.toArray((child as React.ReactElement<{ children?: React.ReactNode }>).props.children).map(extractText).join('');
                                }
                                return '';
                            };
                            const text = React.Children.toArray(children).map(extractText).join('');
                            const slug = headingSlug(text);
                            return React.createElement(tag, { id: slug, 'data-heading': text, ...hProps }, children);
                        };
                        return acc;
                    }, {})),
                    // Tables with proper styling
                    table({ node, children, ...props }) {
                        return (
                            <div className="table-wrapper">
                                <table {...props}>{children}</table>
                            </div>
                        );
                    },
                    // Paragraphs - render as div to prevent hydration errors from nested block elements
                    p({ node, children, ...props }) {
                        // Check if children contain block-level elements
                        const hasBlockChild = React.Children.toArray(children).some((child: React.ReactNode) => {
                            if (React.isValidElement(child)) {
                                const type = child.type;
                                // Check for common block elements
                                return type === 'pre' || type === 'div' || type === 'table' ||
                                    type === 'ul' || type === 'ol' || type === 'blockquote' ||
                                    (typeof type === 'function' && (child.props as { className?: string })?.className?.includes('code-block'));
                            }
                            return false;
                        });

                        // If contains block elements, render as div instead of p
                        if (hasBlockChild) {
                            return <div {...props}>{children}</div>;
                        }
                        return <p {...props}>{children}</p>;
                    },
                    // Allow overriding/extending components
                    ...(props.components || {})
                }}
            >
                {cleanContent}
            </ReactMarkdown>

        </Wrapper>
    );
};

export default React.memo(MarkdownRenderer);
