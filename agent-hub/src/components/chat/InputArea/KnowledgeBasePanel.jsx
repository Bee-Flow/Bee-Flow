/**
 * The knowledge-base picker — what this chat is grounded on, and the one place
 * it can be changed.
 *
 * Every checkbox reflects the SERVER's list (`kbClaim.attachedIds`), never the
 * click that was just made: a toggle sends a PATCH and the box moves when the
 * answer comes back. It is a beat slower than an optimistic tick and it is the
 * only version that cannot show a base the next turn will not actually search.
 *
 * The reasoning about WHICH bases may be offered, and whether a claim can be
 * made at all, is not here — it lives in knowledgeBaseClaim.js and arrives as
 * `kbClaim`. This module owns the panel: the search box, the rows, the
 * visibility badge each base wears, and the refusal line at the bottom.
 *
 * Silence on a failure would read as "it saved", so a refusal always says
 * something; `kbErrorText` turns each reason the route can give into a
 * sentence that names what happened to the selection (nothing did).
 */
import React from 'react';

import useTranslation from '../../../hooks/useTranslation';
import { MAX_ATTACHED_KBS, toggledIds } from '../knowledgeBaseClaim';

const KnowledgeBasePanel = ({
    kbClaim,
    kbPickerOptions,
    kbPickerSearch,
    setKbPickerSearch,
    commitKBIds,
    kbError,
    kbSaving,
    onDone,
}) => {
    const { t } = useTranslation();

    /** Why a change did not land. Silence here would read as "it saved". */
    const kbErrorText = (reason) => {
        switch (reason) {
            case 'invalid':
                return t('chat.composer.kb_error_invalid', 'Some of those knowledge bases are not available to you. Nothing was changed.');
            case 'too_many':
                return t('chat.composer.kb_error_too_many', 'A chat can use at most {count} knowledge bases.', { count: MAX_ATTACHED_KBS });
            case 'forbidden':
                return t('chat.composer.kb_error_forbidden', 'Only the owner can change what this chat is grounded on.');
            case 'gone':
                return t('chat.composer.kb_error_gone', 'This chat is no longer available.');
            case 'unavailable':
                return t('chat.composer.kb_error_unavailable', 'This server cannot store knowledge bases on a chat yet.');
            default:
                return t('chat.composer.kb_error_failed', 'That change could not be saved. Nothing was changed.');
        }
    };

    return (
        <div
            className="absolute bottom-full left-0 mb-2 w-[22rem] rounded-2xl z-50 overflow-hidden"
            role="dialog"
            aria-label={t('chat.composer.kb_panel_title', 'Knowledge bases')}
            data-testid="composer-kb-picker"
            style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-popover, 0 12px 36px rgba(15,23,42,0.18))',
                animation: 'modelTierPanelIn 140ms cubic-bezier(0.22, 1, 0.36, 1) both',
                transformOrigin: 'bottom left',
            }}
        >
            <div className="px-3.5 pt-3 pb-2">
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {t('chat.composer.kb_panel_title', 'Knowledge bases')}
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {t('chat.composer.kb_panel_hint', 'Pick one or more to ground this chat.')}
                </p>
            </div>
            <div className="px-3 pb-2">
                <input
                    type="text"
                    value={kbPickerSearch}
                    onChange={e => setKbPickerSearch(e.target.value)}
                    placeholder={t('chat.composer.kb_search', 'Search…')}
                    aria-label={t('chat.composer.kb_search', 'Search…')}
                    className="w-full px-3 py-1.5 rounded-lg border text-xs outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/25"
                    style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                />
            </div>
            <div className="max-h-72 overflow-auto px-1.5 pb-1.5">
                {kbPickerOptions.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                        {kbClaim.options.length === 0
                            ? t('chat.composer.kb_none', 'No knowledge bases available. Create one in the Knowledge Bases section.')
                            : t('chat.composer.kb_no_matches', 'No matches.')}
                    </div>
                ) : (
                    kbPickerOptions.map(kb => {
                        const checked = kbClaim.attachedIds.includes(kb.id);
                        const isEmpty = !(kb.document_count || 0);
                        // Visibility badge — derive from the actual publish state
                        // rather than just `organization_id`, which is also set on
                        // personal KBs the user created inside an org. Three modes
                        // mirror the publish-menu options (Personal / Org / Groups).
                        const groups = (() => {
                            if (Array.isArray(kb.shared_groups)) return kb.shared_groups;
                            if (typeof kb.shared_groups === 'string') {
                                try { return JSON.parse(kb.shared_groups || '[]'); } catch { return []; }
                            }
                            return [];
                        })();
                        // Theme-aware visibility tags. Personal → neutral chrome;
                        // Org → accent (the org's brand colour); Groups → warning hue.
                        const visibility = !kb.is_published
                            ? { label: t('chat.composer.kb_visibility_personal', 'Personal'), bg: 'var(--bg-tertiary)', fg: 'var(--text-secondary)' }
                            : groups.length > 0
                                ? {
                                    label: groups.length === 1
                                        ? t('chat.composer.kb_visibility_groups', '1 group')
                                        : t('chat.composer.kb_visibility_groups_plural', '{count} groups', { count: groups.length }),
                                    bg: 'color-mix(in srgb, var(--warning) 12%, transparent)',
                                    fg: 'var(--warning)',
                                }
                                : { label: t('chat.composer.kb_visibility_org', 'Org'), bg: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', fg: 'var(--accent-primary)' };
                        return (
                            <label
                                key={kb.id}
                                className="flex items-center gap-3 px-2.5 py-2 rounded-lg cursor-pointer transition-colors"
                                style={{
                                    background: checked ? 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' : 'transparent',
                                }}
                                onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                                onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                            >
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => commitKBIds(toggledIds(kbClaim, kb.id))}
                                    className="accent-[var(--accent-primary)] w-4 h-4 flex-shrink-0"
                                />
                                <span
                                    className="flex-shrink-0 w-7 h-7 rounded-md inline-flex items-center justify-center text-[15px]"
                                    style={{ background: 'var(--bg-secondary)' }}
                                >{kb.icon && (kb.icon.startsWith('data:') || kb.icon.startsWith('http')) ? (
                                    <img src={kb.icon} alt="" className="w-5 h-5 rounded object-cover" />
                                ) : (kb.icon || '📚')}</span>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                        <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{kb.name}</p>
                                        <span
                                            className="px-1.5 py-0.5 rounded font-medium text-[9px] flex-shrink-0 uppercase tracking-wide"
                                            style={{ background: visibility.bg, color: visibility.fg }}
                                        >{visibility.label}</span>
                                    </div>
                                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                        {isEmpty
                                            ? t('chat.composer.kb_empty', 'Empty')
                                            : kb.document_count === 1
                                                ? t('chat.composer.kb_docs', '1 doc')
                                                : t('chat.composer.kb_docs_plural', '{count} docs', { count: kb.document_count || 0 })}
                                    </p>
                                </div>
                            </label>
                        );
                    })
                )}
            </div>
            {kbError && (
                <div
                    className="px-3.5 py-2 text-[11px]"
                    role="status"
                    data-testid="composer-kb-error"
                    style={{ color: 'var(--warning)', borderTop: '1px solid var(--border-subtle)' }}
                >{kbErrorText(kbError)}</div>
            )}
            <div className="px-3 py-2 border-t flex items-center justify-between" style={{ borderColor: 'var(--border-subtle)' }}>
                <button
                    onClick={() => commitKBIds([])}
                    disabled={kbClaim.attachedIds.length === 0 || kbSaving}
                    className="px-2 py-1 rounded-md text-[11px] hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
                    style={{ color: 'var(--text-muted)' }}
                >{t('chat.composer.kb_clear', 'Clear')}</button>
                <div className="flex items-center gap-2">
                    {kbSaving && (
                        <span className="text-[11px]" data-testid="composer-kb-saving" style={{ color: 'var(--text-muted)' }}>
                            {t('chat.composer.kb_saving', 'Saving…')}
                        </span>
                    )}
                    <button
                        onClick={onDone}
                        className="px-3 py-1.5 rounded-md text-[11px] font-semibold"
                        style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg, #fff)' }}
                    >{t('chat.composer.kb_done', 'Done')}</button>
                </div>
            </div>
        </div>
    );
};

export default KnowledgeBasePanel;
