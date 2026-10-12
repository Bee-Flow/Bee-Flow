import React from 'react';
import { STAGE_DOT, useStageLabel } from './StageSwitcher';
import type { StageName } from './stagesApi';

/**
 * A three-dot glyph of the pipeline for a Solution card: Dev, UAT, PRD with a
 * release number beside each. The current stage is ringed; a stage that waits
 * or fails wears a warning or error ring instead. The text label is always
 * there for assistive tech.
 */
export interface StageMiniEntry {
    name: StageName;
    release?: string | null;
    state?: 'ok' | 'waiting' | 'failing' | 'none';
}

export interface StageMiniProps {
    stages: StageMiniEntry[];
    current?: StageName;
}

const STATE_RING: Record<NonNullable<StageMiniEntry['state']>, string> = {
    ok: '',
    waiting: 'ring-2 ring-[var(--warning)] ring-offset-1 ring-offset-[var(--bg-card)]',
    failing: 'ring-2 ring-[var(--error)] ring-offset-1 ring-offset-[var(--bg-card)]',
    none: 'opacity-40',
};

export default function StageMini({ stages, current }: StageMiniProps) {
    const stageName = useStageLabel();
    return (
        <ol className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]" data-testid="stage-mini">
            {stages.map((s, i) => {
                const state = s.state ?? 'ok';
                const isCurrent = s.name === current;
                const ring = isCurrent && state === 'ok'
                    ? 'ring-2 ring-[var(--accent-primary)] ring-offset-1 ring-offset-[var(--bg-card)]'
                    : STATE_RING[state];
                return (
                    <li
                        key={s.name}
                        className="flex items-center gap-1.5"
                        data-testid={`stage-mini-${s.name}`}
                        data-state={state}
                        aria-current={isCurrent ? 'step' : undefined}
                    >
                        {i > 0 && <span className="w-3 h-px bg-[var(--border-default)]" aria-hidden="true" />}
                        <span className={`inline-block w-2.5 h-2.5 rounded-full ${STAGE_DOT[s.name]} ${ring}`} aria-hidden="true" />
                        <span className={isCurrent ? 'font-medium text-[var(--text-primary)]' : ''}>{stageName(s.name)}</span>
                        {s.release ? <span className="tabular-nums text-[var(--text-tertiary)]">{s.release}</span> : null}
                    </li>
                );
            })}
        </ol>
    );
}
