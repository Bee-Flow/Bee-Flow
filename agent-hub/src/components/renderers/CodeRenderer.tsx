import React, { Suspense, lazy } from 'react';
import PageRenderer from './PageRenderer';
import { logger } from '../../utils/logger';
import ResearchRenderer from './ResearchRenderer';
import TestReportRenderer from './TestReportRenderer';
import { CollapsibleCodeBlock } from './CollapsibleCodeBlock';
import MapEmbedRenderer from './MapEmbedRenderer';

const VegaLiteRenderer = lazy(() => import('./VegaLiteRenderer'));

const MermaidRenderer = lazy(() => import('./MermaidRenderer'));

const NOT_JSON = Symbol('not json');
/** The block's parsed JSON, or NOT_JSON while the streamed text is not complete JSON yet. */
function parseBlock(code: string): unknown {
    try { return JSON.parse(code); } catch { return NOT_JSON; }
}

/**
 * Inline loading placeholder shown while a special ```json-*``` block is still
 * streaming or its JSON is incomplete. Extracted from the ~13 identical copies
 * that differed only by their label text.
 */
const BlockLoading = ({ label }: { label: string }) => (
    <div className="my-2 flex items-center gap-3 p-4 rounded-xl bg-[var(--bg-tertiary)]">
        <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
        <span className="text-sm text-[var(--text-muted)]">{label}</span>
    </div>
);

// Code block with language header, copy button, and optional collapsing
// BFSF-273: react-markdown v9 removed the `inline` prop this renderer's code
// component destructured — it was silently undefined ever since the v10
// upgrade, routing EVERY code span (single-backtick inline included) through
// CollapsibleCodeBlock (5 hooks + hljs + measurement timers per token). The
// v10 way to tell them apart is nesting: fenced blocks arrive wrapped in a
// <pre>, inline code does not. The `pre` override below provides this context.
export const PreContext = React.createContext(false);

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
export const CodeRenderer = ({ node, className, children, isLoading = false, ...props }: import('./MarkdownRenderer.types').CodeRendererProps) => {
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
        // Page JSON still incomplete: show the loading indicator.
        if (parseBlock(codeString) === NOT_JSON) return <BlockLoading label="Creating page..." />;
        return (
            <div className="[width:100%] [max-width:100%] [overflow:hidden] [white-space:normal] [font-family:var(--font-sans)]">
                <PageRenderer
                    code={codeString}
                    // Stub handler: page actions have no chat-side behavior yet;
                    // trace them in dev so authors can see the action payload.
                    onAction={(action: { type: string; action?: string }) => logger.debug('Page action:', action)}
                />
            </div>
        );
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
        const researchData = parseBlock(codeString);
        if (researchData === NOT_JSON) return <BlockLoading label="Building research report..." />;
        return (
            <div className="[width:100%] [max-width:100%] [overflow:hidden] [white-space:normal] [font-family:var(--font-sans)]">
                <ResearchRenderer data={researchData as React.ComponentProps<typeof ResearchRenderer>['data']} />
            </div>
        );
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
        const testData = parseBlock(codeString);
        if (testData === NOT_JSON) return <BlockLoading label="Building test report..." />;
        return (
            <div className="[width:100%] [max-width:100%] [overflow:hidden] [white-space:normal] [font-family:var(--font-sans)]">
                <TestReportRenderer data={testData as React.ComponentProps<typeof TestReportRenderer>['data']} />
            </div>
        );
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
        // Vega-Lite JSON still incomplete: show loading.
        if (parseBlock(codeString) === NOT_JSON) return <BlockLoading label="Rendering chart..." />;
        return (
            <div className="[width:100%] [max-width:100%] [overflow:visible] [white-space:normal] [font-family:var(--font-sans)]">
                <Suspense fallback={null}><VegaLiteRenderer spec={codeString} /></Suspense>
            </div>
        );
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
            <div className="[width:100%] [max-width:100%] [overflow:visible] [white-space:normal] [font-family:var(--font-sans)]">
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
        const parsedMap = parseBlock(codeString);
        // Incomplete JSON, or a value without fields (null), is still loading.
        if (parsedMap === NOT_JSON || parsedMap == null) return <BlockLoading label="Loading map..." />;
        const mapData = parsedMap as { embedUrl?: string; title?: string; mapsLink?: string };
        return (
            <div className="[width:100%] [max-width:100%] [overflow:hidden] [white-space:normal] [font-family:var(--font-sans)]">
                <MapEmbedRenderer
                    embedUrl={mapData.embedUrl}
                    title={mapData.title || 'Map'}
                    mapsLink={mapData.mapsLink}
                />
            </div>
        );
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
