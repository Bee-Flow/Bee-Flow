import React, { useState } from 'react';
import { Terminal, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';

export default function ToolOutput({ msg }) {
    const { t } = useTranslation();
    const [showRawToolOutput, setShowRawToolOutput] = useState(false);

    const renderToolOutput = () => {
        let content = msg.content;
        let isJson = false;
        let parsed = null;

        try {
            if (typeof content === 'string' && (content.startsWith('{') || content.startsWith('['))) {
                parsed = JSON.parse(content);
                isJson = true;
            }
        } catch (e) {
            // Not JSON
        }

        return (
            <div className="flex flex-col gap-2 w-full">
                {/* Tool Card Header */}
                <div className="flex items-center gap-2 text-xs font-semibold text-[var(--accent-primary)] uppercase tracking-wider mb-1">
                    <Terminal className="w-3 h-3" />
                    <span>{t('chat.msg.tool_output_of', 'Tool Output: {name}', { name: msg.name || t('chat.msg.tool_system_function', 'System Function') })}</span>
                </div>

                {/* Main Content (Summary/Snippet) */}
                <div className="text-sm text-[var(--text-primary)]">
                    {isJson ? (
                        <div className="flex flex-col gap-2">
                            {/* Try to extract meaningful fields */}
                            {parsed.results && Array.isArray(parsed.results) ? (
                                <div className="space-y-2">
                                    <div className="text-xs text-muted font-medium">{nOf(t, 'chat.msg.tool_results_found', parsed.results.length, '1 result found', '{count} results found')}</div>
                                    {parsed.results.slice(0, 3).map((res, i) => (
                                        <div key={i} className="p-3 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
                                            {res.title && <div className="font-semibold mb-1 truncate">{res.title}</div>}
                                            {res.url && (
                                                <a href={res.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline flex items-center gap-1 mb-1">
                                                    {res.url} <ExternalLink className="w-2.5 h-2.5" />
                                                </a>
                                            )}
                                            {res.content && <div className="text-xs text-muted line-clamp-2">{res.content}</div>}
                                            {/* Fallback if no specific structure */}
                                            {!res.title && !res.url && !res.content && (
                                                <div className="text-xs opacity-70 truncate">{JSON.stringify(res)}</div>
                                            )}
                                        </div>
                                    ))}
                                    {parsed.results.length > 3 && (
                                        <div className="text-xs text-muted italic">{t('chat.msg.tool_more_results', '+ {count} more results...', { count: parsed.results.length - 3 })}</div>
                                    )}
                                </div>
                            ) : parsed.summary ? (
                                <div>{parsed.summary}</div>
                            ) : parsed.error ? (
                                <div className="text-red-500 font-medium">{t('chat.msg.tool_error', 'Error: {reason}', { reason: parsed.error })}</div>
                            ) : (
                                <div className="opacity-80 italic">{t('chat.msg.tool_data_ok', 'Data returned successfully. Check debug view for details.')}</div>
                            )}
                        </div>
                    ) : (
                        <div className="whitespace-pre-wrap font-mono text-xs opacity-80">{content}</div>
                    )}
                </div>

                {/* Debug Toggle */}
                <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                    <button
                        onClick={() => setShowRawToolOutput(!showRawToolOutput)}
                        className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors font-medium border border-transparent hover:bg-white/5 rounded px-1.5 py-0.5"
                    >
                        {showRawToolOutput ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        {t(showRawToolOutput ? 'chat.msg.tool_hide_raw' : 'chat.msg.tool_show_raw',
                            showRawToolOutput ? 'Hide Raw Output' : 'Show Raw Output')}
                    </button>

                    {showRawToolOutput && (
                        <div className="mt-2 p-3 rounded-lg bg-black/30 border border-white/10 font-mono text-[10px] text-green-400 overflow-x-auto whitespace-pre animate-fade-in custom-scrollbar">
                            {content}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // The running-tool chip and its column of ticks that used to live here
    // are <ChatActivity/> now — one numbered timeline, the same shape the
    // builders show, live and after the turn.
    return { renderToolOutput };
}
