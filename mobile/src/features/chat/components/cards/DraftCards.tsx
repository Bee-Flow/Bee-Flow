/** Every draft an answer prepared, in the web's order: e-mail, calendar, LinkedIn, contacts, Keep. */

import React from 'react';

import type { DraftKind, DraftRecord, Drafts } from '@/features/chat/model/types';

import { CalendarDraftCard } from './CalendarDraftCard';
import { ContactsDraftCard } from './ContactsDraftCard';
import { EmailDraftCard } from './EmailDraftCard';
import { KeepDraftCard } from './KeepDraftCard';
import { LinkedInDraftCard } from './LinkedInDraftCard';

const CARD: Readonly<Record<DraftKind, (props: { draft: DraftRecord; draftKey: string }) => React.JSX.Element>> = {
    email: EmailDraftCard,
    calendar: CalendarDraftCard,
    linkedin: LinkedInDraftCard,
    contacts: ContactsDraftCard,
    keep: KeepDraftCard,
};

const ORDER: readonly DraftKind[] = ['email', 'calendar', 'linkedin', 'contacts', 'keep'];

export function DraftCards({ messageId, drafts }: { messageId: string; drafts: Drafts }) {
    return (
        <>
            {ORDER.flatMap((kind) =>
                drafts[kind].map((draft, index) => {
                    const Card = CARD[kind];
                    const key = `${messageId}:${kind}:${index}`;
                    return <Card key={key} draft={draft} draftKey={key} />;
                }),
            )}
        </>
    );
}
