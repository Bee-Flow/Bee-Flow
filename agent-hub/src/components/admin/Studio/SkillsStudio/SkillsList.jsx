import { Plus, Search, Zap } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { kindColorVar } from '../../../shared/kindColors';
import { isEmptySkill, usageSubline } from './skillModel';

/**
 * The 280px skill list (Skills artboard 1a, left column).
 *
 * Three things changed from the old sidebar and each is deliberate:
 *
 *   1. THE EMOJI LEAVES STUDIO. Every row used to open with the skill's own
 *      `icon` — twelve emoji in a column, none of which says "skill". The
 *      row now carries the kind's own glyph in `--kind-skill`, the same
 *      mark the rail, the New menu and the section header use, so the list
 *      reads as one kind rather than twelve things. The `icon` column is
 *      untouched and still paints the chat surfaces (SkillsPopover,
 *      ActiveSkillChips) — this is a Studio decision, not a data change.
 *
 *   2. A SECOND LINE THAT ANSWERS THE ONLY QUESTION. "3 agents · 1
 *      automation" / "not linked yet" / "draft · empty". A skill that is
 *      attached nowhere does nothing at all, and that used to be invisible
 *      until you opened it.
 *
 *   3. THE DELETE BUTTON IS GONE FROM THE ROW. Deleting a skill breaks
 *      every agent that attaches it, and a trash icon that appears on hover
 *      next to the name is one slip away from doing that. It lives on the
 *      detail, under the Used-by list that says what would break.
 *
 * The filter box is always present (never "past four items"): a control
 * that appears with the fifth row cannot be found at the third.
 *
 * ── AN EMPTY COLUMN IS THREE DIFFERENT SENTENCES ────────────────────
 * Nothing on screen looks the same in three situations that are not the
 * same at all, and each one used to print "No skills yet — create one with
 * the + button":
 *
 *   `error`            the list could not be READ. The org may have fifty
 *                      skills. The toast that said so is gone in five
 *                      seconds; this sentence stays, and the counter goes
 *                      away with it — a "0" beside the title is the same
 *                      claim in one character.
 *   a filter is typed  there ARE skills, none of them match. Telling
 *                      somebody their org is empty because they mistyped a
 *                      name is how a filter becomes frightening.
 *   neither            genuinely empty, and the invitation is right.
 *
 * A deviation worth recording: the plan puts this list in `shared/
 * StudioShell`. It is NOT used here, because the shell scrolls its whole
 * sidebar as one column — the filter would scroll off the top exactly when
 * a long list makes it useful — and its `<main>` has neither `min-h-0` nor
 * `min-w-0`, which the detail's own sticky header and 380px rail need. The
 * chrome the shell standardises (280px, the border, the header bar) is
 * matched here to the pixel.
 */
export default function SkillsList({
    skills,
    summary = null,
    loading = false,
    error = null,
    selectedId = null,
    query = '',
    onQuery,
    onSelect,
    onCreate = null,
    canCreate = false,
}) {
    const { t } = useTranslation();
    const rows = Array.isArray(skills) ? skills : [];
    const filtering = String(query || '').trim() !== '';

    return (
        <div
            className="w-[280px] flex-shrink-0 flex flex-col border-r border-[var(--border-default)] bg-[var(--bg-primary)] min-h-0"
            data-testid="skills-list"
        >
            <header className="h-12 flex-shrink-0 flex items-center gap-2 px-3.5 border-b border-[var(--border-default)]">
                <button
                    type="button"
                    onClick={() => onSelect?.(null)}
                    className="text-sm font-semibold text-[var(--text-primary)] hover:underline"
                    data-testid="skills-list-title"
                >
                    {t('skills_studio.title', 'Skills')}
                </button>
                {/* Only ever a count that was COUNTED: after a failed read
                    there are not zero skills, there is no answer — and DURING
                    the read nobody has counted yet either, so a bare "0" stood
                    next to "Loading skills…" for as long as the read took. */}
                {!error && !loading && (
                    <span className="text-xs text-[var(--text-tertiary)] tabular-nums" data-testid="skills-list-count">
                        {rows.length}
                    </span>
                )}
                {canCreate && (
                    <button
                        type="button"
                        onClick={onCreate}
                        aria-label={t('skills_studio.create', 'Create skill')}
                        title={t('skills_studio.create', 'Create skill')}
                        data-testid="skills-list-new"
                        className="ml-auto w-7 h-7 rounded-lg grid place-items-center"
                        style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                    >
                        <Plus size={14} aria-hidden="true" />
                    </button>
                )}
            </header>

            <div className="p-2.5 pb-1.5 flex-shrink-0">
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)]">
                    <Search size={13} className="text-[var(--text-tertiary)] flex-shrink-0" aria-hidden="true" />
                    <input
                        value={query}
                        onChange={(e) => onQuery?.(e.target.value)}
                        placeholder={t('skills_studio.filter', 'Filter…')}
                        aria-label={t('skills_studio.filter', 'Filter…')}
                        data-testid="skills-filter"
                        className="w-full bg-transparent outline-none text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                    />
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-2.5 flex flex-col gap-1">
                {loading && (
                    <p className="text-xs text-[var(--text-tertiary)] px-2 py-3">
                        {t('skills_studio.loading', 'Loading skills…')}
                    </p>
                )}
                {!loading && rows.length === 0 && (
                    <EmptyColumn error={error} filtering={filtering} query={query} t={t} />
                )}
                {rows.map((skill) => (
                    <SkillRow
                        key={skill.id}
                        skill={skill}
                        name={skill.name || t('skills_studio.untitled', 'Untitled skill')}
                        sub={usageSubline(skill, summary?.[skill.id], t)}
                        selected={skill.id === selectedId}
                        onSelect={onSelect}
                    />
                ))}
            </div>
        </div>
    );
}

/**
 * The column with no rows in it — three different situations, three
 * different sentences, never the same one (see the header comment).
 */
function EmptyColumn({ error, filtering, query, t }) {
    if (error) {
        return (
            <p
                role="status"
                data-testid="skills-list-error"
                className="text-xs px-2 py-4 text-center m-0"
                style={{ color: 'var(--warning-ink, var(--warning))' }}
            >
                {t('skills_studio.err_list', 'Could not load the skills.')}
            </p>
        );
    }
    if (filtering) {
        return (
            <p
                // Announced, like the error line right above. This one appears
                // in RESPONSE to typing, which is the moment a screen-reader
                // user has nothing else telling them the rows have gone.
                role="status"
                data-testid="skills-list-nomatch"
                className="text-xs text-[var(--text-tertiary)] px-2 py-4 text-center m-0"
            >
                {t('skills_studio.no_match', 'No skill matches “{query}”.', { query: String(query).trim() })}
            </p>
        );
    }
    return (
        <p className="text-xs text-[var(--text-tertiary)] px-2 py-4 text-center m-0">
            {t('skills_studio.empty', 'No skills yet — create one with the + button.')}
        </p>
    );
}

function SkillRow({ skill, name, sub, selected, onSelect }) {
    // An empty skill is quieter than a real one — it has nothing to say yet.
    const quiet = isEmptySkill(skill);
    return (
        <button
            type="button"
            onClick={() => onSelect?.(skill.id)}
            aria-current={selected ? 'true' : undefined}
            data-testid="skill-row"
            data-skill-id={skill.id}
            className={`w-full text-left flex items-center gap-2 p-2 rounded-lg transition ${
                selected ? 'bg-[var(--bg-card)] shadow-sm' : 'hover:bg-[var(--bg-secondary)]'
            }`}
        >
            <Zap
                size={14}
                aria-hidden="true"
                className="flex-shrink-0"
                style={{ color: quiet ? 'var(--text-tertiary)' : kindColorVar('skill') }}
            />
            <span className="min-w-0 flex-1">
                <span
                    className="block text-xs font-medium truncate"
                    style={{ color: quiet ? 'var(--text-tertiary)' : 'var(--text-primary)' }}
                >
                    {name}
                </span>
                {sub && <span className="block text-xs truncate text-[var(--text-tertiary)]">{sub}</span>}
            </span>
        </button>
    );
}
