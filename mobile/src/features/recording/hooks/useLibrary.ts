/**
 * The Meeting Notes tab's library state: the filters, which tag chips are unfolded,
 * and the report selection. The rows themselves are model/library.ts.
 */

import { useState } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';

import { useTranscriptionTags } from './library';
import {
    DEFAULT_FILTER,
    filterMeetings,
    isFiltering,
    toggleSelected,
    type LibraryFilter,
} from '../model/library';
import type { TranscriptionSummary } from '../model/types';

export function useLibrary(meetings: readonly TranscriptionSummary[]) {
    const { user } = useAuth();
    const userId = user?.id ?? null;
    const [filter, setFilter] = useState<LibraryFilter>(DEFAULT_FILTER);
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    const [reportOpen, setReportOpen] = useState(false);
    const tags = useTranscriptionTags(meetings.length > 0);

    const update = (patch: Partial<LibraryFilter>) => setFilter((prev) => ({ ...prev, ...patch }));

    const startSelecting = () => {
        setSelected([]);
        setSelecting(true);
    };
    const stopSelecting = () => {
        setSelecting(false);
        setSelected([]);
        setReportOpen(false);
    };

    return {
        userId,
        filter,
        update,
        rows: filterMeetings(meetings, filter, userId),
        filtering: isFiltering(filter),
        tags: tags.data ?? [],
        selecting,
        selected,
        startSelecting,
        stopSelecting,
        toggle: (m: TranscriptionSummary) => setSelected((prev) => toggleSelected(prev, m)),
        reportOpen,
        setReportOpen,
        selectedMeetings: meetings.filter((m) => selected.includes(m.id)),
    };
}

export type Library = ReturnType<typeof useLibrary>;
