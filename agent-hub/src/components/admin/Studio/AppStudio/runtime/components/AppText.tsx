import renderInlineMarkdown from '../markdownInline';
import type { NodeProps } from './appNode.types';

/** App Studio runtime — 'text'. Spec: server/appStudio/componentSpecs.js. */

export default function AppText({ node }: NodeProps<{ text?: string; muted?: boolean }>) {
    const { text = '', muted = false } = node.props || {};
    return (
        <p
            className="text-sm leading-relaxed break-words"
            style={muted ? { color: 'var(--text-secondary)' } : undefined}
        >
            {renderInlineMarkdown(text)}
        </p>
    );
}
