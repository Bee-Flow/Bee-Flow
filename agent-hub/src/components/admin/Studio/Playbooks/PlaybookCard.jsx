import { ChevronRight, Clapperboard } from 'lucide-react';
import React from 'react';
import { playbookStatusLabel } from './playbookView';
import { phaseLabel } from './recipes';
import { kindTileStyle } from '../../../shared/kindColors';

/**
 * One playbook in the list. Answers the three things a person asks of a
 * build in progress without opening it: how far is it, is it waiting for me,
 * and what is it. ONE <button>, the chevron is decoration.
 */
function relative(ts, t) {
    const at = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(at)) return '';
    const min = Math.max(0, Math.round((Date.now() - at) / 60000));
    if (min < 1) return t('playbooks.just_now', 'just now');
    if (min < 60) return t('playbooks.minutes_ago', '{n} min ago', { n: min });
    const h = Math.round(min / 60);
    if (h < 48) return t('playbooks.hours_ago', '{n} h ago', { n: h });
    return t('playbooks.days_ago', '{n} d ago', { n: Math.round(h / 24) });
}

export default function PlaybookCard({ t, playbook, onOpen }) {
    const { tile, glyph } = kindTileStyle('playbook', { size: 36, pct: 16 });
    const progress = playbook.progress || { done: 0, total: (playbook.phases || []).length };
    const status = playbookStatusLabel(playbook, t);
    const currentPhase = (playbook.phases || []).find((p) => p && p.key === playbook.currentPhase) || (playbook.currentPhase ? { key: playbook.currentPhase } : null);
    const current = currentPhase ? phaseLabel(currentPhase, t) : null;
    return (
        <li>
            <button
                type="button"
                onClick={onOpen}
                data-testid={`playbook-card-${playbook.id}`}
                className="w-full text-left grid items-center gap-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                    gridTemplateColumns: '36px minmax(0,1fr) auto',
                    padding: '14px 16px',
                    borderRadius: 12,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-default)',
                    boxShadow: 'var(--shadow-sm)',
                    outlineColor: 'var(--accent-primary)',
                }}
            >
                <span style={tile}><Clapperboard style={glyph} aria-hidden="true" /></span>
                <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{playbook.title}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        {/* An AI-written recipe's title IS the playbook's title,
                            so this printed the name twice; and `recipeId` is a
                            machine code, never a word for a person. */}
                        {playbook.recipeLabel && playbook.recipeLabel !== playbook.title && (
                            <><span>{playbook.recipeLabel}</span><span aria-hidden="true">·</span></>
                        )}
                        <span className="tabular-nums">{t('playbooks.progress', '{done}/{total} phases', { done: progress.done, total: progress.total })}</span>
                        {current && playbook.status === 'active' && (<><span aria-hidden="true">·</span><span>{current}</span></>)}
                        <span aria-hidden="true">·</span>
                        <span style={{ color: status.tone, fontWeight: 600 }}>{status.text}</span>
                        {playbook.updatedAt && (<><span aria-hidden="true">·</span><span>{relative(playbook.updatedAt, t)}</span></>)}
                    </span>
                </span>
                <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            </button>
        </li>
    );
}
