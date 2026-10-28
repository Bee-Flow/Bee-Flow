import React, { useRef, useEffect } from 'react';
import { Download, FileText } from 'lucide-react';
import { API_BASE } from '@/utils/helpers';
import useTranslation from '@/hooks/useTranslation';
import type { ChatMessage } from './messageTypes';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';

interface TerminalCommand {
    tool?: string;
    args?: { command?: string; description?: string; code?: string; packages?: string; path?: string };
}

interface TerminalOutput {
    content?: string;
    success?: boolean;
}

interface TerminalFile {
    name?: string;
    size: number;
    agentId?: string;
    path: string;
    containerKey?: string;
}

/** The terminal commands, outputs and files a turn produced. */
export interface TerminalActivity {
    commands?: TerminalCommand[];
    outputs?: Array<TerminalOutput | null>;
    files?: TerminalFile[];
    statusMessage?: string;
}

interface TerminalEntry {
    cmd: TerminalCommand;
    output: TerminalOutput | null;
    isCurrent: boolean;
}

export default function TerminalProgress({ msg, allMessages }: { msg: ChatMessage; allMessages?: ChatMessage[] }) {
    const { t } = useTranslation();
    const terminalRef = useRef<HTMLDivElement>(null);
    const prevCmdCount = useRef(0);

    // Auto-scroll terminal when new commands/outputs arrive
    useEffect(() => {
        const ta = msg.terminalActivity;
        const cmdCount = (ta?.commands?.length || 0) + (ta?.outputs?.length || 0);
        if (cmdCount > prevCmdCount.current && terminalRef.current) {
            terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
        }
        prevCmdCount.current = cmdCount;
    }, [msg.terminalActivity]);

    const ta = msg.terminalActivity;
    if (!ta) return null;

    // Only render the terminal on the LAST message that has terminalActivity.
    if (allMessages && allMessages.length > 0) {
        let foundSelf = false;
        for (const m of allMessages) {
            if (m.id === msg.id) { foundSelf = true; continue; }
            if (foundSelf && m.terminalActivity) {
                return null;
            }
        }
    }

    // Collect ALL terminal entries from every message in the conversation
    const allEntries: TerminalEntry[] = [];
    if (allMessages && allMessages.length > 0) {
        for (const m of allMessages) {
            if (m.terminalActivity) {
                const cmds = m.terminalActivity.commands || [];
                const outs = m.terminalActivity.outputs || [];
                const isCurrent = m.id === msg.id;
                cmds.forEach((cmd: TerminalCommand, i: number) => {
                    allEntries.push({ cmd, output: outs[i] || null, isCurrent });
                });
            }
        }
    }

    const isRunning = msg.isStreaming;
    const totalCommands = allEntries.length;
    const firstCurrentIdx = allEntries.findIndex((e: TerminalEntry) => e.isCurrent);

    const getCommandDisplay = (cmd: TerminalCommand) => {
        if (cmd.tool === 'run_command') return cmd.args?.command || '';
        if (cmd.tool === 'python_exec') return `python3 -c "${(cmd.args?.description || cmd.args?.code?.split('\n')[0] || 'script').slice(0, 60)}"`;
        if (cmd.tool === 'pip_install') return `pip install ${cmd.args?.packages || ''}`;
        if (cmd.tool === 'write_file') return `cat > ${cmd.args?.path || 'file'}`;
        if (cmd.tool === 'read_file') return `cat ${cmd.args?.path || 'file'}`;
        return cmd.tool;
    };

    return (
        <div className="mb-3 rounded-xl overflow-hidden shadow-lg [border:1px_solid_#2a2a2a] [background:#1a1a2e]">
            <div className="flex items-center gap-2 px-3 py-2 [background:#16162a] [border-bottom:1px_solid_#2a2a3e]">
                <div className="flex gap-1.5">
                    <span className="w-3 h-3 rounded-full [background:#ff5f57]"></span>
                    <span className="w-3 h-3 rounded-full [background:#febc2e]"></span>
                    <span className="w-3 h-3 rounded-full [background:#28c840]"></span>
                </div>
                <span className="flex-1 text-center text-[11px] font-medium [color:#6b7280]!">
                    {nOf(t, 'chat.msg.term_commands', totalCommands, 'terminal — 1 command', 'terminal — {count} commands')}
                </span>
                {isRunning && (
                    <span className="w-2 h-2 rounded-full animate-pulse [background:#28c840]"></span>
                )}
            </div>

            <div
                ref={terminalRef}
                className="overflow-y-auto overflow-x-hidden custom-scrollbar"
                style={{
                    maxHeight: '400px',
                    padding: '12px 14px',
                    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', 'Consolas', monospace",
                    fontSize: '12px',
                    lineHeight: '1.6',
                }}
            >
                {allEntries.map((entry: TerminalEntry, i: number) => {
                    const cmdText = getCommandDisplay(entry.cmd);
                    const isLast = i === allEntries.length - 1;
                    const waitingForOutput = !entry.output && isLast && isRunning;
                    const isPrior = !entry.isCurrent;
                    const showSeparator = firstCurrentIdx > 0 && i === firstCurrentIdx;

                    return (
                        <React.Fragment key={i}>
                            {showSeparator && (
                                <div className="my-2 flex items-center gap-2 [color:#4b5563]">
                                    <div className="flex-1 [border-bottom:1px_dashed_#374151]"></div>
                                    <span className="text-[10px] px-2">{t('chat.msg.term_new_session', 'new session')}</span>
                                    <div className="flex-1 [border-bottom:1px_dashed_#374151]"></div>
                                </div>
                            )}
                            <div className="mb-2 last:mb-0" style={isPrior ? { opacity: 0.6 } : undefined}>
                                <div className="flex items-start gap-0 flex-wrap">
                                    <span className="[color:#28c840] [font-weight:600]">❯ </span>
                                    <span className="[color:#e2e8f0] [word-break:break-all]">{cmdText}</span>
                                </div>
                                {entry.output && entry.output.content && (
                                    <pre className="whitespace-pre-wrap mt-0.5" style={{
                                        color: entry.output.success ? '#94a3b8' : '#f87171',
                                        margin: 0,
                                        wordBreak: 'break-word',
                                    }}>
                                        {isPrior
                                            ? (entry.output.content.length > 200
                                                ? entry.output.content.slice(0, 200) + '...'
                                                : entry.output.content)
                                            : entry.output.content.slice(0, 3000)}
                                    </pre>
                                )}
                                {entry.output && !entry.output.success && (
                                    <div className="mt-0.5 [color:#f87171] [font-size:11px]">
                                        ✗ {t('chat.msg.term_exit_error', 'exited with error')}
                                    </div>
                                )}
                                {waitingForOutput && (
                                    <div className="flex items-center gap-1 mt-1">
                                        <span className="inline-block w-2 h-4 animate-pulse [background:#28c840]"></span>
                                    </div>
                                )}
                            </div>
                        </React.Fragment>
                    );
                })}

                {ta.statusMessage && isRunning && allEntries.length === 0 && (
                    <div className="[color:#6b7280]">
                        {ta.statusMessage}
                    </div>
                )}
            </div>

            {/* Files section — show downloadable files */}
            {(() => {
                const allFiles: TerminalFile[] = [];
                if (allMessages && allMessages.length > 0) {
                    for (const m of allMessages) {
                        if (m.terminalActivity?.files) {
                            for (const f of m.terminalActivity.files) {
                                if (!allFiles.find((ef: TerminalFile) => ef.name === f.name)) {
                                    allFiles.push(f);
                                }
                            }
                        }
                    }
                }
                if (allFiles.length === 0) return null;

                const formatSize = (bytes: number) => {
                    if (bytes < 1024) return `${bytes} B`;
                    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                };

                return (
                    <div className="[border-top:1px_solid_#2a2a3e] [padding:10px_14px] [background:#16162a]">
                        <div className="flex items-center gap-1.5 mb-2 [color:#6b7280] [font-size:11px]">
                            <FileText size={12} />
                            <span>{t('chat.msg.term_files', 'Files ({count})', { count: allFiles.length })}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {allFiles.map((file: TerminalFile, i: number) => (
                                <a
                                    key={i}
                                    href={`${API_BASE}/agents/${file.agentId}/files/download?path=${encodeURIComponent(file.path)}${file.containerKey ? `&conversationId=${encodeURIComponent(file.containerKey)}` : ''}`}
                                    download={file.name}
                                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all [background:#1e1e3a] [border:1px_solid_#2a2a4e] [color:#a5b4fc] [font-size:12px] [text-decoration:none]"
                                    onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => {
                                        e.currentTarget.style.background = '#2a2a4e';
                                        e.currentTarget.style.borderColor = '#4338ca';
                                    }}
                                    onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => {
                                        e.currentTarget.style.background = '#1e1e3a';
                                        e.currentTarget.style.borderColor = '#2a2a4e';
                                    }}>
                                    <Download size={13} />
                                    <span>{file.name}</span>
                                    <span className="[color:#4b5563] [font-size:10px]">{formatSize(file.size)}</span>
                                </a>
                            ))}
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}
