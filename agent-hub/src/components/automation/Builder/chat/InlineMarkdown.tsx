import MarkdownRenderer from '../../../renderers/MarkdownRenderer';

/**
 * A line the model wrote, drawn with its inline markdown (bold, italics, code,
 * links) and nothing block-level. For the spots where a list or a heading
 * would only break the card: a question prompt, an answer option, a plan line.
 *
 * `whitespace-pre-line` keeps the line breaks the model put in, `break-words`
 * lets a long identifier or URL wrap in the narrow side panel instead of
 * pushing the card wider.
 */
export default function InlineMarkdown({ text, className = '' }: { text: string; className?: string }) {
    return <MarkdownRenderer inline content={text} className={`whitespace-pre-line break-words [overflow-wrap:anywhere] ${className}`.trim()} />;
}
