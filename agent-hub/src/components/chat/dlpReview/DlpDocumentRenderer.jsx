/**
 * Renders a reviewed ATTACHMENT (PDF, Word, Excel/CSV, plain text) as a
 * page-shaped card — not the literal file (no PDF/spreadsheet renderer
 * exists in this app, and the product requirement is explicit that it
 * doesn't need to be), but recognizable: a titled document card with the
 * extracted text inside it, highlighted the same way the chat-text renderer
 * highlights a typed message.
 *
 * Spreadsheet content (server/core/documents/documentParser.js emits a fixed
 * markdown pipe-table for XLSX/XLS/CSV) renders as an actual HTML table —
 * recognizable as "the spreadsheet", not a wall of `| a | b |` text — with
 * each cell its own windowed DlpHighlightedText (see dlpTableParse.js for
 * how a cell's offset stays anchored to the flat text the server's findings
 * are offset against). Anything else (PDF/Word/plain text) flows as one
 * block, exactly as before.
 */
import { FileText } from 'lucide-react';
import React, { useMemo } from 'react';
import { spansInRange } from './dlpFindingsState';
import DlpHighlightedText from './DlpHighlightedText';
import { parseMarkdownDocument, looksLikeMarkdownTable } from './dlpTableParse';

function TableBlock({ block, spans, onAddSpan, onRemoveSpan }) {
    return (
        <table className="w-full text-xs border-collapse mb-3 last:mb-0">
            <tbody>
                {block.rows.map((row, ri) => (
                    <tr key={ri} className={ri === 0 ? 'font-semibold' : ''} style={ri === 0 ? { background: 'var(--bg-tertiary)' } : undefined}>
                        {row.map((cell, ci) => (
                            <td
                                key={ci}
                                className="border px-2 py-1 align-top"
                                style={{ borderColor: 'var(--border-subtle)' }}
                            >
                                <DlpHighlightedText
                                    text={cell.value}
                                    spans={spansInRange(spans, cell.start, cell.end)}
                                    baseOffset={cell.start}
                                    onAddSpan={onAddSpan}
                                    onRemoveSpan={onRemoveSpan}
                                    dense
                                />
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function TextBlock({ block, spans, onAddSpan, onRemoveSpan }) {
    if (!block.value) return <div className="h-2" />;
    return (
        <div className="mb-1.5 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            <DlpHighlightedText
                text={block.value}
                spans={spansInRange(spans, block.start, block.end)}
                baseOffset={block.start}
                onAddSpan={onAddSpan}
                onRemoveSpan={onRemoveSpan}
                dense
            />
        </div>
    );
}

export default function DlpDocumentRenderer({ filename, text, spans, onAddSpan, onRemoveSpan }) {
    const isTable = useMemo(() => looksLikeMarkdownTable(text), [text]);
    const blocks = useMemo(() => (isTable ? parseMarkdownDocument(text || '') : null), [isTable, text]);

    return (
        <div
            className="mx-auto w-full max-w-xl rounded-lg border shadow-sm"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}
        >
            <div
                className="flex items-center gap-2 px-4 py-2.5 border-b text-xs font-medium"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
                <FileText className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{filename}</span>
            </div>
            <div className={isTable ? 'p-3 max-h-80 overflow-auto custom-scrollbar' : 'px-5 py-4 max-h-80 overflow-y-auto custom-scrollbar'}>
                {isTable
                    ? blocks.map((block, i) => block.type === 'table'
                        ? <TableBlock key={i} block={block} spans={spans} onAddSpan={onAddSpan} onRemoveSpan={onRemoveSpan} />
                        : <TextBlock key={i} block={block} spans={spans} onAddSpan={onAddSpan} onRemoveSpan={onRemoveSpan} />)
                    : <DlpHighlightedText text={text} spans={spans} onAddSpan={onAddSpan} onRemoveSpan={onRemoveSpan} />}
            </div>
        </div>
    );
}
