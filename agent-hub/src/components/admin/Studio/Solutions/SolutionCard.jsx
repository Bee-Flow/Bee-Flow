import React from 'react';
import { CountChips, HealthChip, RunLine, StageTrack, SubLine, UpdateChip } from './SolutionCardParts';
import { healthOf, updateOf } from './solutionOverviewModel';
import { kindTileStyle } from '../../../shared/kindColors';

/**
 * One Solution, as a card on the overview. The whole card is ONE button (no
 * nested interactive elements); every decision on it was made in
 * solutionOverviewModel.js and the pieces live in SolutionCardParts.tsx.
 * Layout: icon + name + role, health chip; description; stage track; count
 * chips; footer with runs and the Blueprint-update chip.
 */
export default function SolutionCard({ row, onOpen }) {
    const health = healthOf(row);
    const update = updateOf(row);
    const tile = kindTileStyle('solution', 36);

    return (
        <button
            type="button"
            onClick={() => onOpen?.(row)}
            className="flex flex-col gap-3 p-4 lg:p-5 rounded-[var(--radius-lg)] text-left border w-full min-h-[44px] bg-[var(--bg-card)] border-[var(--border-subtle)] transition-colors duration-150 motion-reduce:transition-none hover:bg-[var(--bg-card-hover)] hover:border-[var(--border-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            data-testid="solutions-card"
            data-project={row.id}
        >
            <span className="flex items-start gap-3 w-full">
                <span style={tile.tile} aria-hidden="true">
                    <span className="text-lg leading-none">{row.icon || '\u{1F4E6}'}</span>
                </span>
                <span className="flex-1 min-w-0">
                    <span className="block text-[15px] font-semibold truncate text-[var(--text-primary)]">
                        {row.name}
                    </span>
                    <SubLine row={row} update={update} />
                </span>
                <HealthChip health={health} />
            </span>

            {row.description && (
                <span className="block text-[13px] line-clamp-2 text-[var(--text-secondary)]">
                    {row.description}
                </span>
            )}

            <StageTrack stages={row.stages} />

            <CountChips row={row} />

            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] mt-auto pt-3 border-t border-[var(--border-subtle)]">
                <RunLine row={row} />
                <UpdateChip update={update} />
            </span>
        </button>
    );
}
