// The versions of one item, newest first, grouped per day. A row says when,
// what (its name, or what kind of save it was), who (avatars, and an AI chip
// when the AI took part) and how much changed. Runs of small automatic saves
// fold into one "N small edits" row that opens in place, so the list reads as
// the moments that mattered.

import { Bookmark, ChevronRight, Pin, Sparkles } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type { VersionMeta } from '../../api/queries/versions';
import useTranslation from '../../hooks/useTranslation';
import {
    contributorLine, contributorSummary, foldQuiet, groupByDay, sourceLabel, statsText, type PeopleNames,
} from './versionText';

export interface VersionListProps {
    versions: VersionMeta[];
    selectedId: string | null;
    onSelect: (version: VersionMeta) => void;
    people: PeopleNames;
    currentUserId?: string | null;
    hasMore?: boolean;
    loadingMore?: boolean;
    onLoadMore?: () => void;
}

function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts[parts.length - 1][0]}`).toUpperCase();
}

export function AvatarStack({ names, max = 3 }: { names: string[]; max?: number }) {
    const shown = names.slice(0, max);
    const extra = names.length - shown.length;
    return (
        <span className="flex -space-x-1.5" aria-hidden="true">
            {shown.map((n, i) => (
                <span key={`${n}-${i}`} title={n} className="w-5 h-5 inline-grid place-items-center rounded-full text-[9px] font-semibold bg-[var(--bg-tertiary)] text-[var(--text-secondary)] ring-2 ring-[var(--bg-card)]">
                    {initials(n)}
                </span>
            ))}
            {extra > 0 && <span className="w-5 h-5 inline-grid place-items-center rounded-full text-[9px] bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] ring-2 ring-[var(--bg-card)]">+{extra}</span>}
        </span>
    );
}

export function AiChip() {
    const { t } = useTranslation();
    return (
        <span className="inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)]">
            <Sparkles className="w-2.5 h-2.5" aria-hidden="true" />
            {t('versions.ai_chip', 'AI')}
        </span>
    );
}

function VersionRow({ version, selected, onSelect, people, currentUserId }: {
    version: VersionMeta;
    selected: boolean;
    onSelect: (v: VersionMeta) => void;
    people: PeopleNames;
    currentUserId?: string | null;
}) {
    const { t } = useTranslation();
    const line = contributorLine(t, version.contributors, people, currentUserId);
    const who = contributorSummary(t, line);
    const stats = statsText(t, version.stats);
    const at = new Date(version.createdAt);
    const time = Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return (
        <li>
            <button
                type="button"
                onClick={() => onSelect(version)}
                aria-pressed={selected}
                data-testid={`version-row-${version.id}`}
                className={`w-full text-left rounded-lg px-2.5 py-2 transition-colors ${selected ? 'bg-[var(--bg-tertiary)] ring-1 ring-[var(--border-default)]' : 'hover:bg-[var(--item-hover-bg)]'}`}
            >
                <span className="flex items-center gap-1.5">
                    <span className="text-[11.5px] tabular-nums text-[var(--text-tertiary)] w-11 flex-shrink-0">{time}</span>
                    {version.name && <Bookmark className="w-3.5 h-3.5 flex-shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />}
                    <span className={`flex-1 min-w-0 truncate text-[12.5px] ${version.name ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                        {version.name || sourceLabel(t, String(version.source))}
                    </span>
                    {version.pinned && <Pin className="w-3 h-3 flex-shrink-0 text-[var(--text-tertiary)]" aria-label={t('versions.pinned', 'Kept for good')} />}
                </span>
                <span className="mt-1 flex items-center gap-1.5 pl-[3.1rem]">
                    {line.people.length > 0 && <AvatarStack names={line.people.map((p) => p.name)} />}
                    <span className="min-w-0 truncate text-[11.5px] text-[var(--text-tertiary)]">{who}</span>
                    {line.ai && <AiChip />}
                    {stats && <span className="ml-auto flex-shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]">{stats}</span>}
                </span>
            </button>
        </li>
    );
}

export default function VersionList({ versions, selectedId, onSelect, people, currentUserId, hasMore, loadingMore, onLoadMore }: VersionListProps) {
    const { t } = useTranslation();
    const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());
    const groups = useMemo(() => groupByDay(t, versions), [t, versions]);
    const keepOpen = useMemo(() => new Set(selectedId ? [selectedId] : []), [selectedId]);
    const row = (v: VersionMeta) => (
        <VersionRow key={v.id} version={v} selected={v.id === selectedId} onSelect={onSelect} people={people} currentUserId={currentUserId} />
    );

    return (
        <div className="space-y-4" data-testid="version-list">
            {groups.map((group) => (
                <section key={group.key} aria-labelledby={`version-day-${group.key}`}>
                    <h3 id={`version-day-${group.key}`} className="m-0 mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
                        {group.label}
                    </h3>
                    <ul className="m-0 p-0 list-none space-y-0.5">
                        {foldQuiet(group.items, keepOpen).map((entry) => {
                            if (entry.kind === 'version') return row(entry.version);
                            if (openFolds.has(entry.id)) return <React.Fragment key={entry.id}>{entry.versions.map(row)}</React.Fragment>;
                            return (
                                <li key={entry.id}>
                                    <button
                                        type="button"
                                        onClick={() => setOpenFolds((s) => new Set([...s, entry.id]))}
                                        className="w-full flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-secondary)]"
                                        data-testid="version-fold"
                                    >
                                        <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                                        {t('versions.list.small_edits', '{n} small edits', { n: entry.versions.length })}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ))}
            {hasMore && (
                <div className="flex justify-center">
                    <button
                        type="button"
                        onClick={onLoadMore}
                        disabled={loadingMore}
                        className="h-8 px-3 rounded-lg text-[12.5px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                        data-testid="version-more"
                    >
                        {loadingMore ? t('versions.list.loading_more', 'Loading…') : t('versions.list.more', 'Show older versions')}
                    </button>
                </div>
            )}
        </div>
    );
}
