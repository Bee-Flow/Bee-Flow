import { Check, MoreHorizontal, Pencil, Pin, PinOff, Tag, Trash2, Users, X } from 'lucide-react';
import React, { useState, useRef, useEffect } from 'react';
import CreateLabelInline from './CreateLabelInline';
import EditLabelInline from './EditLabelInline';
import { ACCENT_BAR_CONV, CONV_ROW, TEXT_ACTIVE, TEXT_IDLE } from './sidebarTokens';
import { projectChipStyle, projectIcon } from '../../projects/workspace/projectVisuals';
import useConfirm from '../../shared/useConfirm';

/* ─── Conversation row (module-level to avoid closure issues in minified builds) ─── */
const ConvRow = ({
    conv, t, active,
    selectConv, deleteConv,
    conversationLabels, projects, activeProjectId,
    onRenameConversation, onPinConversation, onLabelConversation,
    onDeleteLabel, onEditLabel, onCreateLabel, onMoveToProject, onShareToProject,
    agentBadge,
}) => {
    const [showMenu, setShowMenu] = useState(false);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(conv.title || '');
    const [editingLabelId, setEditingLabelId] = useState(null);
    const menuRef = useRef(null);
    const inputRef = useRef(null);
    const { confirm, confirmDialog } = useConfirm();

    // Close menu on outside click
    useEffect(() => {
        if (!showMenu) return;
        const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false); };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [showMenu]);

    // Focus input when rename starts
    useEffect(() => {
        if (isRenaming && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isRenaming]);

    const handleRename = () => {
        const trimmed = renameValue.trim();
        if (trimmed && trimmed !== conv.title) {
            onRenameConversation?.(conv, trimmed);
        }
        setIsRenaming(false);
    };

    const handlePin = () => {
        onPinConversation?.(conv);
        setShowMenu(false);
    };

    if (isRenaming) {
        return (
            <div className={`${CONV_ROW} pr-2`}>
                <input
                    ref={inputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={handleRename}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename();
                        if (e.key === 'Escape') { setRenameValue(conv.title || ''); setIsRenaming(false); }
                    }}
                    className="flex-1 text-[13px] bg-[var(--bg-card)] border border-[var(--accent-primary)] rounded px-1.5 py-0.5 outline-none text-[var(--text-primary)] min-w-0"
                    onClick={(e) => e.stopPropagation()}
                />
            </div>
        );
    }

    return (
        <div
            onClick={() => selectConv(conv)}
            className={`group ${CONV_ROW}`}
            title={conv.updated_at ? new Date(conv.updated_at).toLocaleString() : ''}
            data-testid={`conv-row-${conv.id}`}
        >
            {active && <div className={ACCENT_BAR_CONV} />}
            {conv.pinned && <Pin className="w-3 h-3 text-[var(--accent-primary)] flex-shrink-0 -rotate-45" />}
            {/* Label dots */}
            {(() => { try { const ls = JSON.parse(conv.labels_json || '[]'); const applied = ls.map(lid => (conversationLabels || []).find(x => x.id === lid)).filter(Boolean); if (!applied.length) return null; return (
                <div className="flex items-center gap-1 flex-shrink-0 max-w-[55%] overflow-hidden">
                    {/* Show the first applied label as a readable name-pill and any
                        extras as larger dots, so the applied state is actually
                        visible instead of an easily-missed 8px dot (BFSF-212). */}
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium truncate"
                          style={{ background: `${applied[0].color}22`, color: applied[0].color, border: `1px solid ${applied[0].color}` }}
                          title={applied.map(l => l.name).join(', ')}>
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: applied[0].color }} />
                        {applied[0].name}
                    </span>
                    {applied.slice(1).map(l => (
                        <span key={l.id} className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-white/50" style={{ background: l.color }} title={l.name} />
                    ))}
                </div>
            ); } catch { return null; } })()}
            {/* Agent avatar to the left */}
            {agentBadge && (
                <div className={`w-6 h-6 rounded-md flex-shrink-0 overflow-hidden flex items-center justify-center text-[11px] font-bold ring-1 ${agentBadge.avatarUrl ? 'ring-black/8 bg-[var(--bg-tertiary)]' : 'ring-black/8 bg-gradient-to-br from-[var(--accent-primary)]/10 to-[var(--accent-primary)]/25 text-[var(--accent-primary)]'}`}>
                    {agentBadge.avatarUrl ? (
                        <img src={agentBadge.avatarUrl} alt="" loading="lazy" className="w-full h-full object-cover" />
                    ) : (
                        <span className="leading-none">{agentBadge.icon}</span>
                    )}
                </div>
            )}
            <span className={`text-[14px] truncate flex-1 leading-snug min-w-0 ${active ? TEXT_ACTIVE : TEXT_IDLE}`}>
                {conv.title || t('sidebar.untitled_chat')}
            </span>
            {/* Which project this chat is filed under. Project chats are no
                longer hidden from the general lists, so the chip is what keeps
                the filing visible — otherwise they would look identical to
                unfiled ones. Suppressed while inside that project, where every
                row would carry the same chip. */}
            {(() => {
                if (!conv.project_id || activeProjectId === conv.project_id) return null;
                const p = projects?.find(pr => pr.id === conv.project_id);
                if (!p) return null;
                // The colour goes through the same check as everywhere a
                // project is painted: any editor can set it, every member sees it.
                return (
                    <span
                        className="flex-shrink-0 text-[10px] px-1 py-px rounded flex items-center gap-0.5 max-w-[80px]"
                        style={projectChipStyle(p.color)}
                        title={t('sidebar.conv_in_project', 'In project: {name}', { name: p.name })}
                    >
                        <span aria-hidden="true">{projectIcon(p.icon)}</span>
                        <span className="truncate">{p.name}</span>
                    </span>
                );
            })()}
            {/* Three-dot menu */}
            <div className="relative" ref={menuRef}>
                <button
                    onClick={(e) => { e.stopPropagation(); setShowMenu(v => !v); }}
                    className={`${showMenu ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100 focus:opacity-100 p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded transition-opacity flex-shrink-0`}
                    title="Options"
                    data-testid={`conv-options-${conv.id}`}
                >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                </button>
                {showMenu && (
                    <div
                        className="absolute right-0 top-full mt-1 w-52 rounded-lg border shadow-xl overflow-hidden z-50"
                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-subtle)', animation: 'sidebarMenuIn .15s ease-out' }}
                    >
                        <div className="p-1">
                            {/* Pin / Unpin */}
                            <button
                                onClick={(e) => { e.stopPropagation(); handlePin(); }}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-[var(--bg-secondary)] rounded-md transition-colors text-left text-[var(--text-primary)]"
                            >
                                {conv.pinned
                                    ? <><PinOff className="w-3.5 h-3.5" /> {t('sidebar.unpin')}</>
                                    : <><Pin className="w-3.5 h-3.5" /> {t('sidebar.pin_to_top')}</>
                                }
                            </button>
                            {/* Rename */}
                            <button
                                onClick={(e) => { e.stopPropagation(); setShowMenu(false); setIsRenaming(true); }}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-[var(--bg-secondary)] rounded-md transition-colors text-left text-[var(--text-primary)]"
                            >
                                <Pencil className="w-3.5 h-3.5" /> {t('sidebar.rename')}
                            </button>
                            {/* Labels */}
                            <div className="mx-1 my-1 border-t border-[var(--border-subtle)]" />
                            <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] flex items-center gap-1.5">
                                <Tag className="w-3 h-3" /> {t('sidebar.labels')}
                            </div>
                            <div className="max-h-40 overflow-y-auto">
                                {(conversationLabels || []).map(label => {
                                    if (editingLabelId === label.id) {
                                        return <EditLabelInline key={label.id} label={label} onSave={(id, updates) => { onEditLabel?.(id, updates); setEditingLabelId(null); }} onCancel={() => setEditingLabelId(null)} t={t} />;
                                    }
                                    const convLabels = (() => { try { return JSON.parse(conv.labels_json || '[]'); } catch { return []; } })();
                                    const has = convLabels.includes(label.id);
                                    return (
                                        <div key={label.id} className="group/lbl flex items-center">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); onLabelConversation?.(conv, label.id); }}
                                                className="flex-1 flex items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-[var(--bg-secondary)] rounded-md transition-colors text-left text-[var(--text-primary)] min-w-0"
                                            >
                                                <div className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-black/10" style={{ background: label.color }} />
                                                <span className="flex-1 truncate">{label.name}</span>
                                                {has && <Check className="w-3.5 h-3.5 text-[var(--accent-primary)] flex-shrink-0" />}
                                            </button>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setEditingLabelId(label.id); }}
                                                className="p-1 text-[var(--text-tertiary)] hover:text-[var(--accent-primary)] rounded transition-all flex-shrink-0 opacity-0 group-hover/lbl:opacity-100"
                                                title="Edit label"
                                            >
                                                <Pencil className="w-2.5 h-2.5" />
                                            </button>
                                            <button
                                                onClick={async (e) => { e.stopPropagation(); if (await confirm({ title: `Delete label "${label.name}"?`, confirmLabel: 'Delete', destructive: true })) onDeleteLabel?.(label.id); }}
                                                className="p-1 mr-1 text-[var(--text-tertiary)] hover:text-red-500 rounded transition-all flex-shrink-0 opacity-0 group-hover/lbl:opacity-100"
                                                title="Delete label"
                                            >
                                                <X className="w-2.5 h-2.5" />
                                            </button>
                                        </div>
                                    );
                                })}
                                {(conversationLabels || []).length === 0 && (
                                    <div className="px-2.5 py-1.5 text-[11px] text-[var(--text-tertiary)] italic">{t('sidebar.no_labels_yet')}</div>
                                )}
                            </div>
                            {/* Create new label inline */}
                            <CreateLabelInline onCreateLabel={onCreateLabel} t={t} />
                            {/* Move to project */}
                            {(projects || []).length > 0 && (
                                <>
                                    <div className="mx-1 my-1 border-t border-[var(--border-subtle)]" />
                                    {conv.project_id && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onMoveToProject?.(conv, null); setShowMenu(false); }}
                                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-[var(--bg-secondary)] rounded-md transition-colors text-left text-[var(--text-secondary)]"
                                        >
                                            <X className="w-3.5 h-3.5" /> {t('sidebar.remove_from_project')}
                                        </button>
                                    )}
                                    {(projects || []).filter(p => p.id !== conv.project_id).map(p => (
                                        <button
                                            key={p.id}
                                            onClick={(e) => { e.stopPropagation(); onMoveToProject?.(conv, p); setShowMenu(false); }}
                                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-[var(--bg-secondary)] rounded-md transition-colors text-left text-[var(--text-primary)]"
                                        >
                                            <div className="w-4 h-4 rounded flex items-center justify-center text-[10px] flex-shrink-0" style={{ background: (p.color || '#6366f1') + '20' }}>
                                                {p.icon || '📁'}
                                            </div>
                                            <span className="truncate">{p.name}</span>
                                        </button>
                                    ))}
                                </>
                            )}
                            {/* Share into the project this chat is filed under.
                                Separate from "move to project" on purpose:
                                filing is private bookkeeping, sharing publishes
                                the conversation to every member and re-encrypts
                                it. Conflating the two would share people's chats
                                without them asking. Only offered once the chat
                                is already in a project, so the target is
                                unambiguous. */}
                            {conv.project_id && onShareToProject && (
                                <>
                                    <div className="mx-1 my-1 border-t border-[var(--border-subtle)]" />
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onShareToProject(conv); setShowMenu(false); }}
                                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-[var(--bg-secondary)] rounded-md transition-colors text-left text-[var(--text-secondary)]"
                                    >
                                        <Users className="w-3.5 h-3.5" />
                                        {conv.shared_scope === 'project'
                                            ? t('projects.unshare_thread')
                                            : t('projects.share_thread')}
                                    </button>
                                </>
                            )}
                            {/* Delete */}
                            <div className="mx-1 my-1 border-t border-[var(--border-subtle)]" />
                            <button
                                onClick={(e) => { e.stopPropagation(); deleteConv(conv); setShowMenu(false); }}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-red-50 rounded-md transition-colors text-left text-red-500"
                                data-testid={`conv-delete-${conv.id}`}
                            >
                                <Trash2 className="w-3.5 h-3.5" /> {t('common.delete')}
                            </button>
                        </div>
                    </div>
                )}
            </div>
            {/* React bubbles the portal's clicks to this row, and a click in the dialog must not select the conversation. */}
            <span onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>{confirmDialog}</span>
        </div>
    );
};

export default ConvRow;
