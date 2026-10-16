import type { ComponentPropsWithoutRef } from 'react';
import type { Components } from 'react-markdown';

/** A multimodal message part: only `text` parts carry markdown. */
export interface MarkdownContentPart {
    type?: string;
    text?: string;
}

/** What `content` may hold: markdown text, a multimodal array, or an object with `text`. */
export type MarkdownContent = string | MarkdownContentPart[] | { text?: string };

export interface MarkdownRendererProps {
    content?: MarkdownContent | null;
    className?: string;
    isLoading?: boolean;
    /** Keep only the marks of a short line of prose (bold, code, links). */
    inline?: boolean;
    /** Overrides merged over the built-in element renderers. */
    components?: Components;
}

export type CodeProps = ComponentPropsWithoutRef<'code'>;

export interface CodeRendererProps extends CodeProps {
    node?: unknown;
    isLoading?: boolean;
}

export type HeadingProps = ComponentPropsWithoutRef<'h1'> & { node?: unknown };
