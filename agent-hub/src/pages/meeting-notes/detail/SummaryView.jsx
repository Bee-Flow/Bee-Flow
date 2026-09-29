import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, ChevronDown, Loader2, Pencil, Plus, Star } from 'lucide-react';
import MarkdownRenderer from '../../../components/renderers/MarkdownRenderer';
import useTranslation from '../../../hooks/useTranslation';
import { buildSummaryStamp, SUMMARY_STAMP } from '../lib/summaryStamp';

// Fallback built-ins used before the server list has loaded (keeps the menu
// populated instantly and covers hosts that don't pass `templates`).
const FALLBACK_BUILTINS = [
    { id: 'general', name: 'General meeting' },
    { id: 'standup', name: 'Stand-up' },
    { id: 'sales', name: 'Sales call' },
    { id: 'interview', name: 'Interview' },
    { id: 'retrospective', name: 'Retrospective' },
];

/**
 * "Met welk sjabloon is deze samenvatting geschreven" — de ZIN.
 *
 * De TOESTAND komt uit lib/summaryStamp.js; hier wordt alleen de sleutel
 * gekozen, en de ternary staat om de SLEUTEL heen, nooit om een letter.
 *
 * Twee toestanden zwijgen: geen stempel (o.a. elke notitie van vóór deze
 * kolommen, en elke samenvatting uit een eenmalige prompt) en een
 * sjabloonlijst die nog niet binnen is. Een versienummer verzinnen voor een
 * notitie waarvan het sjabloon onbekend is, is precies wat hier niet gebeurt.
 *
 * Geen taalschakelaar ernaast: er bestaat geen vertaling van transcripten,
 * dus zo'n knop zou iets beloven wat het product niet doet.
 */
function stampSentence(stamp, t) {
    if (stamp.state === SUMMARY_STAMP.NONE || stamp.state === SUMMARY_STAMP.LOADING) return null;
    if (stamp.state === SUMMARY_STAMP.GONE) {
        // Versie bekend, naam niet — en WAAROM de naam ontbreekt weet dit
        // scherm niet. `GET /api/summary-templates` levert per LEZER: zijn
        // eigen user-scope sjablonen plus zijn org en zijn groepen. Een
        // collega die een gedeelde notitie opent mist Ann's persoonlijke
        // sjabloon dus altijd — niet omdat het weg is, maar omdat het niet van
        // hem is. Dat is niet de uitzondering maar de normale gang van zaken
        // voor elke gedeelde notitie die met een persoonlijk (of andermans
        // groeps-) sjabloon geschreven is.
        //
        // "Bestaat niet meer" is dan een bewering die dit scherm niet kan
        // controleren, en die in het gedeelde geval onwaar is. Onbekend
        // versmalt: de zin zegt alleen wat in BEIDE gevallen waar is — deze
        // lezer kan dit sjabloon niet inzien.
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
    // De notitie zelf — alleen `summaryTemplateId` / `summaryTemplateVersion`
    // worden gelezen, voor de regel "met welk sjabloon is dit geschreven".
    meeting = null,
}) {
    const { t } = useTranslation();
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef(null);

    useEffect(() => {
        function handler(e) {
            if (menuOpen && menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
        }
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [menuOpen]);

    const builtins = templates?.builtins?.length ? templates.builtins : FALLBACK_BUILTINS;
    const custom = Array.isArray(templates?.custom) ? templates.custom : [];
    const defaultTemplateId = templates?.defaultTemplateId || null;
    const canManageOrg = !!templates?.canManageOrg;
    const mine = custom.filter((tpl) => tpl.scope === 'user');
    const orgTemplates = custom.filter((tpl) => tpl.scope === 'org' || tpl.scope === 'group');
    const canManageTemplates = typeof onNewTemplate === 'function';

    function pick(payload) {
        setMenuOpen(false);
        onRegenerate?.(payload);
    }

    function sectionHeader(label) {
        return (
            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                {label}
            </div>
        );
    }

    function customRow(tpl) {
        return (
            <div key={tpl.id} className="group flex items-center hover:bg-[var(--bg-tertiary)]">
                <button
                    type="button"
                    onClick={() => pick({ templateId: tpl.id })}
                    className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs flex items-center gap-1.5"
                    style={{ color: 'var(--text-primary)' }}
                >
                    {defaultTemplateId === tpl.id && <Star className="w-3 h-3 flex-shrink-0 fill-current" style={{ color: 'var(--accent-primary)' }} />}
                    <span className="truncate">{tpl.name}</span>
                    {tpl.scope === 'group' && (
                        <span className="ml-1 px-1 py-px rounded text-[9px] font-medium" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                            {t('meeting_notes.template_badge_group', 'group')}
                        </span>
                    )}
                </button>
                {canManageTemplates && (tpl.scope === 'user' || canManageOrg) && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onEditTemplate?.(tpl); }}
                        className="px-2 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ color: 'var(--text-muted)' }}
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
                    <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('meeting_notes.summary', 'Summary')}</h2>
                    {stampText && (
                        <p className="mt-0.5 text-[11px] truncate" style={{ color: 'var(--text-muted)' }} data-testid="summary-template-stamp">
                            {stampText}
                        </p>
                    )}
                </div>
                {onRegenerate && (
                    <div className="relative" ref={menuRef}>
                        <button
                            type="button"
                            onClick={() => setMenuOpen((o) => !o)}
                            disabled={regenerating}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60"
                            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                        >
                            {regenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                            {t('meeting_notes.regenerate', 'Regenerate')}
                            <ChevronDown className="w-3 h-3" />
                        </button>
                        {menuOpen && (
                            <div
                                className="absolute right-0 top-full mt-1 z-10 w-60 max-h-[60vh] overflow-auto rounded-lg border shadow-lg"
                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}
                            >
                                {(mine.length > 0 || orgTemplates.length > 0) && sectionHeader(t('meeting_notes.template_section_builtin', 'Built-in'))}
                                {builtins.map((tpl) => (
                                    <button
                                        key={tpl.id}
                                        type="button"
                                        onClick={() => pick({ template: tpl.id })}
                                        className="block w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)]"
                                        style={{ color: 'var(--text-primary)' }}
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
                                        <div className="border-t my-1" style={{ borderColor: 'var(--border-subtle)' }} />
                                        <button
                                            type="button"
                                            onClick={() => { setMenuOpen(false); onNewTemplate?.(); }}
                                            className="flex items-center gap-1.5 w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-tertiary)]"
                                            style={{ color: 'var(--accent-primary)' }}
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
            <div className="flex-1 overflow-auto rounded-xl border px-4 py-3" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                {summary ? (
                    <MarkdownRenderer content={summary} />
                ) : (
                    <div className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
                        {t('meeting_notes.no_summary', 'No summary yet.')}
                    </div>
                )}
            </div>
        </div>
    );
}
