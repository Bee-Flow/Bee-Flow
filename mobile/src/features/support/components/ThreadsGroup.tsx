/**
 * Your requests. The server caps the list at fifty (threads/mine), so this is
 * a bounded card of rows rather than a virtualised list.
 */

import React from 'react';

import { Group } from '@/shared/ui';

import { ThreadRow } from './ThreadRow';
import type { SupportThread } from '../model/types';

export function ThreadsGroup({
    threads,
    onOpen,
}: {
    threads: SupportThread[];
    onOpen: (id: string) => void;
}) {
    return (
        <Group
            title="Your requests"
            footer="Bee Flow answers most questions itself within a minute or two, and hands anything it cannot to a person."
        >
            {threads.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} onOpen={() => onOpen(thread.id)} />
            ))}
        </Group>
    );
}
