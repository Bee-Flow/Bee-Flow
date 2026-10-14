import renderInlineMarkdown from '../markdownInline';
import type { RuntimeNode } from './runtimeNode.types';

/** App Studio runtime — 'text'. Spec: server/appStudio/componentSpecs.js. */

interface AppTextProps {
    node: RuntimeNode<{ text?: string; muted?: boolean }>;
}

export default function AppText({ node }: AppTextProps) {
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
