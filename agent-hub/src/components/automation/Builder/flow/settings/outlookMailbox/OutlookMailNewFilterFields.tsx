import React from 'react';
import OutlookMailboxPicker from './OutlookMailboxPicker';
import type { FilterFieldsProps } from '../triggerFilters.types';

/**
 * msgraph.mail.new: which inbox the trigger watches. The own inbox is a Graph
 * subscription; a shared mailbox is polled (Graph has no change notifications
 * for shared mailboxes on delegated access), which the hint says.
 */
export function OutlookMailNewFilterFields({ filter, setFilter }: FilterFieldsProps) {
    return (
        <OutlookMailboxPicker
            value={typeof filter.mailbox === 'string' ? filter.mailbox : undefined}
            onChange={(next) => setFilter('mailbox', next)}
            polled
        />
    );
}
