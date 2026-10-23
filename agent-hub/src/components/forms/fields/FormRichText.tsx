import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FormRichTextProps, MdProps } from '../PublicFormRenderer.types';

// Every description on a form page — a mid-run question as much as the closing
// summary — is where the automation SHOWS the visitor something: the keyword it
// picked and why, the competitor analysis it just did, the text it wrote, a
// link to the document. Rendered as a flat paragraph that meant reading raw
// `##` and `**` and copy-pasting URLs by hand.
//
// react-markdown escapes embedded HTML unless rehype-raw is added; it is not
// added, deliberately. These pages are served to anonymous visitors and their
// text can carry model output, so nothing here may become live markup.
const FORM_MD_COMPONENTS = {
    a: ({ node: _node, ...props }: MdProps<'a'>) => (
        <a {...props} target="_blank" rel="noopener noreferrer nofollow"
            style={{ color: 'var(--app-primary)', textDecoration: 'underline' }} />
    ),
    h1: ({ node: _node, ...props }: MdProps<'h1'>) => <h2 {...props} className="text-lg font-semibold mt-5 mb-2 text-[var(--text-primary)]" />,
    h2: ({ node: _node, ...props }: MdProps<'h2'>) => <h3 {...props} className="text-base font-semibold mt-5 mb-1.5 text-[var(--text-primary)]" />,
    h3: ({ node: _node, ...props }: MdProps<'h3'>) => <h4 {...props} className="text-sm font-semibold mt-4 mb-1 text-[var(--text-primary)]" />,
    p: ({ node: _node, ...props }: MdProps<'p'>) => <p {...props} className="mb-3" />,
    ul: ({ node: _node, ...props }: MdProps<'ul'>) => <ul {...props} className="list-disc pl-5 mb-3 flex flex-col gap-1" />,
    ol: ({ node: _node, ...props }: MdProps<'ol'>) => <ol {...props} className="list-decimal pl-5 mb-3 flex flex-col gap-1" />,
    strong: ({ node: _node, ...props }: MdProps<'strong'>) => <strong {...props} className="text-[var(--text-primary)]" />,
    hr: ({ node: _node, ...props }: MdProps<'hr'>) => <hr {...props} className="my-5" style={{ borderColor: 'var(--border-subtle)' }} />,
    blockquote: ({ node: _node, ...props }: MdProps<'blockquote'>) => (
        <blockquote {...props} className="pl-3 my-3" style={{ borderLeft: '3px solid var(--border-default)' }} />
    ),
    // GFM tables had no entry here at all, so they rendered as a bare <table>
    // with zero cell padding: the widest label in a two-column fact table ran
    // straight into its value ("Director ruleauto"). A snapshot table is the
    // most common thing an approval's details block contains, and a form
    // description's second most common, so it gets real cells — and a scroll
    // box, so a wide one cannot push the column sideways.
    table: ({ node: _node, ...props }: MdProps<'table'>) => (
        <div className="my-3 overflow-x-auto">
            <table {...props} className="w-auto min-w-0 border-collapse text-left" />
        </div>
    ),
    th: ({ node: _node, ...props }: MdProps<'th'>) => (
        <th {...props} className="py-1 pr-6 last:pr-0 align-top font-semibold text-[var(--text-primary)]" />
    ),
    td: ({ node: _node, ...props }: MdProps<'td'>) => <td {...props} className="py-1 pr-6 last:pr-0 align-top" />,
};

export function FormRichText({ children, className = '', style = null }: FormRichTextProps) {
    return (
        <div className={className} style={style as React.CSSProperties}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={FORM_MD_COMPONENTS}>{children}</ReactMarkdown>
        </div>
    );
}
