import { Check, ChevronDown, Sparkles, TriangleAlert, Zap } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import useTranslation from '../../../../hooks/useTranslation';
import AnchoredMenu from '../../../shared/AnchoredMenu';
import { kindColorVar } from '../../../shared/kindColors';
import { SORT_MODES, isEmptySkill, metaLine, sortSkills, testChip, testChipColor, usageSubline } from './skillModel';

/**
 * "All skills" — the landing with no skill selected (Skills artboard 1c,
 * right).
 *
 * Four columns, and each answers a question the old Studio could not:
 *   Skill      name + "4 steps · 3 rules · 2 examples"
 *   Used by    "3 agents · 1 automation" — from `GET /usage-summary`
 *   Last time  when the skill last actually fired (`skill_activations`)
 *   Test       the last Test-tab verdict (`lastTest`, S1)
 *
 * ── AN ABSENT COUNT IS NOT A ZERO ───────────────────────────────────
 * `usage-summary` omits a skill it cannot count, and `lastUsedAt` is null
 * until something records an activation. Both render as an em dash, not as
 * "nobody" / "never": the difference between "nothing uses this" and "we
 * have not looked" is the whole reason someone opens this table.
 *
 * ── AND "NO ROWS" IS THREE SENTENCES HERE TOO ───────────────────────
 * The left column learned this first; this is the bigger surface, so the same
 * lie is louder here. `rows` is the FILTERED list the host hands down
 * (index.jsx passes `shown`), and a filter that matches nothing produced
 * "Create your first skill" — an invitation to redo work that is sitting one
 * backspace away — while the list beside it correctly said "No skill matches
 * “zzzz”". The heading count went to 0 in the same render. So the query comes
 * down with the rows, and the invitation is kept for the one case that
 * deserves it: read, unfiltered, and genuinely empty.
 *
 * ── AND AN EMPTY SKILL GETS AN OFFER, NOT A VERDICT ─────────────────
 * A skill with no steps and no description has never been tested and never
 * could be. Its Test cell offers "Let AI fill it in" (S3's
 * `POST /:id/ai/improve`) instead of the honest-but-useless "not tested".
 *
 * The artboard's "default for Meeting notes" and "uses table Pricelist"
 * sublines are NOT rendered: the first has no data model (the "template ≠
 * skill" decision in M4), and the second would need a per-row lookup of
 * every referenced table's name for a line nobody sorts by. Recorded
 * deviations.
 */
export default function SkillsOverview({
    skills,
    summary = null,
    loading = false,
    error = null,
    // The filter the host applied to `skills` before handing them over. Without
    // it this component cannot tell "no skills" from "none match".
    query = '',
    onOpen,
    onImprove = null,
}) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const [mode, setMode] = useState('used');
    const rows = useMemo(() => sortSkills(skills, mode, summary), [skills, mode, summary]);
    const filtering = String(query || '').trim() !== '';

    return (
        <div className="h-full flex flex-col min-h-0 bg-[var(--bg-primary)]" data-testid="skills-overview">
            <header className="h-11 flex-shrink-0 flex items-center gap-2 px-4 border-b border-[var(--border-default)]">
                <Zap size={14} aria-hidden="true" style={{ color: kindColorVar('skill') }} />
                <h1 className="text-[13px] font-semibold text-[var(--text-primary)] m-0">
                    {t('skills_studio.overview.title', 'All skills')}
                </h1>
                {/* As in the list: a count that nobody counted is not 0 — and
                    during the read nobody has counted yet either, so the 0
                    stood next to the spinner for as long as the spinner did. */}
                {!error && !loading && <span className="text-xs text-[var(--text-tertiary)] tabular-nums">{rows.length}</span>}
                <SortMenu mode={mode} onMode={setMode} t={t} />
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto">
                <div
                    role="row"
                    className="grid gap-3 px-4 py-2 border-b border-[var(--border-default)] text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]"
                    style={{ gridTemplateColumns: '1fr 130px 150px 110px' }}
                >
                    <span>{t('skills_studio.overview.col_skill', 'Skill')}</span>
                    <span>{t('skills_studio.overview.col_usedby', 'Used by')}</span>
                    <span>{t('skills_studio.overview.col_last', 'Last time')}</span>
                    <span>{t('skills_studio.overview.col_test', 'Test')}</span>
                </div>

                {loading && (
                    <p className="text-xs text-[var(--text-tertiary)] px-4 py-6 m-0">
                        {t('skills_studio.loading', 'Loading skills…')}
                    </p>
                )}
                {/* "Create your first skill" is an invitation built on a
                    count. Off a read that failed it is an invitation to
                    re-create work that is already there. */}
                {!loading && error && (
                    <p
                        role="status"
                        data-testid="skills-overview-error"
                        className="text-xs px-4 py-6 m-0"
                        style={{ color: 'var(--warning-ink, var(--warning))' }}
                    >
                        {t('skills_studio.err_list', 'Could not load the skills.')}
                    </p>
                )}
                {/* There ARE skills — none of them match what was typed. The
                    invitation below would tell somebody their organisation is
                    empty because they mistyped a name. */}
                {!loading && !error && rows.length === 0 && filtering && (
                    <p
                        role="status"
                        data-testid="skills-overview-nomatch"
                        className="text-xs text-[var(--text-tertiary)] px-4 py-10 text-center m-0"
                    >
                        {t('skills_studio.no_match', 'No skill matches “{query}”.', { query: String(query).trim() })}
                    </p>
                )}
                {!loading && !error && rows.length === 0 && !filtering && (
                    <div className="px-4 py-10 text-center" data-testid="skills-overview-empty">
                        <p className="text-sm font-semibold text-[var(--text-primary)] m-0">
                            {t('skills_studio.empty_title', 'Create your first skill')}
                        </p>
                        <p className="text-xs text-[var(--text-tertiary)] max-w-md mx-auto mt-2 m-0 leading-relaxed">
                            {t('skills_studio.empty_help', 'Skills are reusable instruction packs you can attach to any agent. Create one to define how an agent should behave in a specific situation.')}
                        </p>
                    </div>
                )}

                {rows.map((skill) => (
                    <OverviewRow
                        key={skill.id}
                        skill={skill}
                        summary={summary?.[skill.id]}
                        onOpen={onOpen}
                        onImprove={onImprove}
                        rel={rel}
                        t={t}
                    />
                ))}
            </div>
        </div>
    );
}

const SORT_LABEL = {
    used: { key: 'skills_studio.sort.used', en: 'most used' },
    recent: { key: 'skills_studio.sort.recent', en: 'last used' },
    name: { key: 'skills_studio.sort.name', en: 'name' },
};

function SortMenu({ mode, onMode, t }) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef(null);
    const label = t(SORT_LABEL[mode].key, SORT_LABEL[mode].en);
    return (
        <div className="ml-auto">
            <button
                type="button"
                ref={anchorRef}
                onClick={() => setOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                data-testid="skills-sort"
                className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
            >
                {t('skills_studio.sort.label', 'Sort: {mode}', { mode: label })}
                <ChevronDown size={12} aria-hidden="true" className="opacity-60" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="right"
                width={180}
                role="menu"
                aria-label={t('skills_studio.sort.aria', 'Sort skills')}
                className="py-1"
            >
                {SORT_MODES.map((value) => (
                    <button
                        key={value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={value === mode}
                        onClick={() => { onMode(value); setOpen(false); }}
                        className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition ${
                            value === mode
                                ? 'text-[var(--text-primary)] bg-[var(--bg-secondary)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
                        }`}
                    >
                        <Check size={13} aria-hidden="true" className={value === mode ? 'opacity-100' : 'opacity-0'} />
                        {t(SORT_LABEL[value].key, SORT_LABEL[value].en)}
                    </button>
                ))}
            </AnchoredMenu>
        </div>
    );
}

function OverviewRow({ skill, summary, onOpen, onImprove, rel, t }) {
    const empty = isEmptySkill(skill);
    const chip = testChip(skill.lastTest, t);
    const usedBy = usageSubline(skill, summary, t);
    const lastAt = summary?.lastUsedAt || skill.lastUsedAt || null;

    return (
        <div
            role="row"
            data-testid="skills-overview-row"
            data-skill-id={skill.id}
            className="grid gap-3 items-center px-4 py-2.5 border-b border-[var(--border-default)] hover:bg-[var(--bg-secondary)] transition"
            style={{ gridTemplateColumns: '1fr 130px 150px 110px' }}
        >
            <button
                type="button"
                onClick={() => onOpen?.(skill.id)}
                className="text-left min-w-0"
            >
                <span
                    className="block text-xs font-medium truncate"
                    style={{ color: empty ? 'var(--text-tertiary)' : 'var(--text-primary)' }}
                >
                    {skill.name || t('skills_studio.untitled', 'Untitled skill')}
                </span>
                <span className="block text-xs text-[var(--text-tertiary)] truncate">{metaLine(skill, t)}</span>
            </button>

            <span className="text-xs truncate" style={{ color: usedBy ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}>
                {usedBy || '—'}
            </span>

            <span className="text-xs truncate" style={{ color: lastAt ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}>
                {lastAt ? rel(lastAt) : '—'}
            </span>

            {/* An offer the server would refuse is not an offer. `POST
                /:id/ai/improve` answers 403 `not_editable` on a skill this
                account may see but not edit, so the row does not hold the
                door open. `!== false` and not `=== true` on purpose: rows
                from older read paths carry no `canEdit` at all, and an
                unknown must not make a whole column of skills quietly lose
                the offer — only an explicit "no" from the server does. */}
            {empty && onImprove && skill.canEdit !== false ? (
                <button
                    type="button"
                    onClick={() => onImprove(skill.id)}
                    data-testid="skills-overview-fill"
                    className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                >
                    <Sparkles size={12} aria-hidden="true" style={{ color: 'var(--type-ai)' }} />
                    {t('skills_studio.overview.fill', 'Let AI fill it in')}
                </button>
            ) : (
                <span
                    className="inline-flex items-center gap-1.5 text-xs"
                    data-testid="skills-overview-test"
                    data-tone={chip.tone}
                    style={{ color: testChipColor(chip.tone) }}
                >
                    {chip.tone === 'ok' && <Check size={12} aria-hidden="true" />}
                    {(chip.tone === 'warning' || chip.tone === 'error') && <TriangleAlert size={12} aria-hidden="true" />}
                    {chip.label}
                </span>
            )}
        </div>
    );
}
