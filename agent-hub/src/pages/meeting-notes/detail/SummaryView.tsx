import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, ChevronDown, Loader2, Pencil, Plus, Star } from 'lucide-react';
import MarkdownRenderer from '@/components/renderers/MarkdownRenderer';
import useTranslation from '@/hooks/useTranslation';
import { buildSummaryStamp, SUMMARY_STAMP } from '../lib/summaryStamp';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { MeetingNote } from './meetingDetailTypes';
import type { BuiltinTemplate, CustomTemplate, SummaryTemplates } from './summaryTemplates.types';

/** What the Regenerate menu asks for: a built-in key or a saved template. */
type RegeneratePick = { template: string } | { templateId: string };

interface SummaryViewProps {
    summary?: string;
    onRegenerate?: (pick: RegeneratePick) => void;
    regenerating?: boolean;
    templates?: SummaryTemplates | null;
    onNewTemplate?: () => void;
    onEditTemplate?: (template: CustomTemplate) => void;
    meeting?: MeetingNote | null;
}

// Fallback built-ins used before the server list has loaded (keeps the menu
// populated instantly and covers hosts that don't pass `templates`).
const FALLBACK_BUILTINS: BuiltinTemplate[] = [
    { id: 'general', name: 'General meeting' },
    { id: 'standup', name: 'Stand-up' },
    { id: 'sales', name: 'Sales call' },
    { id: 'interview', name: 'Interview' },
    { id: 'retrospective', name: 'Retrospective' },
];

/**
 * "With which template this summary was written": the SENTENCE.
 *
 * The STATE comes from lib/summaryStamp.js. Here only the key is chosen, and the ternary
 * stands around the KEY, never around a letter.
 *
 * Two states stay silent: no stamp (e.g. every note from before these columns, and
 * every summary from a one-off prompt), and a template list that has not yet arrived.
 * Inventing a version number for a note whose template is unknown is precisely what
 * does not happen here.
 *
 * There is no language switch beside it. There is no translation of transcripts, so
 * such a button would promise something the product does not do.
 */
function stampSentence(stamp: ReturnType<typeof buildSummaryStamp>, t: TranslateFn) {
    if (stamp.state === SUMMARY_STAMP.NONE || stamp.state === SUMMARY_STAMP.LOADING) return null;
    if (stamp.state === SUMMARY_STAMP.GONE) {
        // Version known, name not. And WHY the name is missing, this screen does not know.
        // `GET /api/summary-templates` supplies, per READER, his own user-scope templates plus
        // his org and his groups. A colleague who opens a shared note always misses Ann's
        // personal template, not because it is gone but because it is not his. That is not
        // the exception but the normal course of events for every shared note that was
        // written with a personal (or someone else's group) template.
        //
        // "No longer exists" is then a claim that this screen cannot check, and that is
        // untrue in the shared case. Unknown narrows: the sentence says only what is true in
        // BOTH cases, namely that this reader cannot see this template.
        return stamp.version
            ? t('meeting_notes.template_stamp_unavailable_versioned', 'Template: not available to you (v{version})', { version: stamp.version })
            : t('meeting_notes.template_stamp_unavailable', 'Template: not available to you');
    }
    const name = stamp.nameKey ? t(stamp.nameKey, stamp.name || '') : stamp.name;
    if (!name) return null;
    return stamp.version
        ? t('meeting_notes.template_stamp_versioned', 'Template: {name} (v{version})', { name, version: stamp.version })
        : t('meeting_notes.template_stamp', 'Template: {name}', { name });
}

export default function SummaryView({
    summary,
    onRegenerate,
    regenerating,
    templates = null,          // { builtins, custom, defaultTemplateId, canManageOrg }
    onNewTemplate,
    onEditTemplate,
    // The note itself. Only `summaryTemplateId` / `summaryTemplateVersion` are read, for
    // the rule "with which template this was written".
    meeting = null,
}: SummaryViewProps) {
    const { t } = useTranslation();
    const [menuOpen, setMenuOpen] = useState<boolean>(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handler(e: MouseEvent) {
            if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node | null)) setMenuOpen(false);
        }
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [menuOpen]);

    const builtins = templates?.builtins?.length ? templates.builtins : FALLBACK_BUILTINS;
    const custom = Array.isArray(templates?.custom) ? templates.custom : [];
    const defaultTemplateId = templates?.defaultTemplateId || null;
    const canManageOrg = !!templates?.canManageOrg;
    const mine = custom.filter((tpl: CustomTemplate) => tpl.scope === 'user');
    const orgTemplates = custom.filter((tpl: CustomTemplate) => tpl.scope === 'org' || tpl.scope === 'group');
    const canManageTemplates = typeof onNewTemplate === 'function';

    function pick(payload: RegeneratePick) {
        setMenuOpen(false);
        onRegenerate?.(payload);
    }

    function sectionHeader(label: string) {
        return (
            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {label}
            </div>
        );
    }

    function customRow(tpl: CustomTemplate) {
        return (
            <div key={tpl.id} className="group flex items-center hover:bg-[var(--bg-tertiary)]">
                <button
                    type="button"
                    onClick={() => pick({ templateId: tpl.id })}
                    className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs flex items-center gap-1.5 text-[var(--text-primary)]"
                >
                    {defaultTemplateId === tpl.id && <Star className="w-3 h-3 flex-shrink-0 fill-current text-[var(--accent-primary)]" />}
                    <span className="truncate">{tpl.name}</span>
                    {tpl.scope === 'group' && (
                        <span className="ml-1 px-1 py-px rounded text-[9px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                            {t('meeting_notes.template_badge_group', 'group')}
                        </span>
                    )}
                </button>
                {canManageTemplates && (tpl.scope === 'user' || canManageOrg) && (
                    <button
                        type="button"
                        onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); setMenuOpen(false); onEditTemplate?.(tpl); }}
                        className="px-2 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity text-[var(--text-muted)]"
                        aria-label={t('meeting_notes.template_edit', 'Edit template')}
                    >
                        <Pencil className="w-3 h-3" />
                    </button>
                )}
            </div>
        );
    }

    // "Template: Board summary (v4)" — of niets. Zie stampSentence().
    const stampText = stampSentence(buildSummaryStamp(meeting, templates), t);

    return (
        <div className="flex flex-col gap-3 h-full">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('meeting_notes.summary', 'Summary')}</h2>
                    {stampText && (
                        <p className="mt-0.5 text-[11px] truncate text-[var(--text-muted)]" data-testid="summary-template-stamp">
                            {stampText}
                        </p>
                    )}
                </div>
                {onRegenerate && (
                    <div className="relative" ref={menuRef}>
                        <button
                            type="button"
                            onClick={() => setMenuOpen((o: boolean) => !o)}
                            disabled={regenerating}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60 border-[var(--border-default)] text-[var(--text-secondary)]"
                        >
                            {regenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                            {t('meeting_notes.regenerate', 'Regenerate')}
                            <ChevronDown className="w-3 h-3" />
                        </button>
                        {menuOpen && (
                            <div
                                className="absolute right-0 top-full mt-1 z-10 w-60 max-h-[60vh] overflow-auto rounded-lg border shadow-lg bg-[var(--bg-secondary)] border-[var(--border-default)]"
                            >
                                {(mine.length > 0 || orgTemplates.length > 0) && sectionHeader(t('meeting_notes.template_section_builtin', 'Built-in'))}
                                {builtins.map((tpl: BuiltinTemplate) => (
                                    <button
                                        key={tpl.id}
                                        type="button"
                                        onClick={() => pick({ template: tpl.id })}
                                        className="block w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                                    >
                                        {tpl.nameKey ? t(tpl.nameKey, tpl.name) : tpl.name}
                                    </button>
                                ))}

                                {mine.length > 0 && sectionHeader(t('meeting_notes.template_section_mine', 'My templates'))}
                                {mine.map(customRow)}

                                {orgTemplates.length > 0 && sectionHeader(t('meeting_notes.template_section_org', 'Organization'))}
                                {orgTemplates.map(customRow)}

                                {canManageTemplates && (
                                    <>
                                        <div className="border-t my-1 border-[var(--border-subtle)]" />
                                        <button
                                            type="button"
                                            onClick={() => { setMenuOpen(false); onNewTemplate?.(); }}
                                            className="flex items-center gap-1.5 w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-tertiary)] text-[var(--accent-primary)]"
                                        >
                                            <Plus className="w-3 h-3" />
                                            {t('meeting_notes.template_new', 'New template…')}
                                        </button>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
            <div className="flex-1 overflow-auto rounded-xl border px-4 py-3 bg-[var(--bg-secondary)] border-[var(--border-default)]">
                {summary ? (
                    <MarkdownRenderer content={summary} />
                ) : (
                    <div className="text-sm text-center py-8 text-[var(--text-muted)]">
                        {t('meeting_notes.no_summary', 'No summary yet.')}
                    </div>
                )}
            </div>
        </div>
    );
}
