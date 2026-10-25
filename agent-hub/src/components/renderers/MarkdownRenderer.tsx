import React, { useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
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
import { PreContext, CodeRenderer } from './CodeRenderer';
import WebpageLinkCard from '../webpages/WebpageLinkCard';
import DocumentLinkCard from '../documents/DocumentLinkCard';
import { DOCUMENT_CARD, WEBPAGE_CARD, WRAPPING_FENCE_CLOSE, WRAPPING_FENCE_OPEN, anchorKey, headingSlug, stripDirectiveBlocks } from './markdownRules';

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
            <MarkdownRendererReactMarkdown inline={inline} isLoading={isLoading} props={props} cleanContent={cleanContent} />

        </Wrapper>
    );
};

export default React.memo(MarkdownRenderer);

function MarkdownRendererReactMarkdown({ inline, isLoading, props, cleanContent }: { inline: boolean; isLoading: boolean; props: { components?: Components; }; cleanContent: string; }) {
    return <ReactMarkdown
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
                            } }
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
                        if ((child as React.ReactElement<{ children?: React.ReactNode; }>)?.props?.children) {
                            return React.Children.toArray((child as React.ReactElement<{ children?: React.ReactNode; }>).props.children).map(extractText).join('');
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
                            (typeof type === 'function' && (child.props as { className?: string; })?.className?.includes('code-block'));
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
    </ReactMarkdown>;
}
