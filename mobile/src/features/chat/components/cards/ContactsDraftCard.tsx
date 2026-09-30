/** A contact the assistant drafted — new or updated — with its details, and Confirm. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { executeDraft } from '@/features/chat/api/drafts';
import { useDraftAction } from '@/features/chat/hooks/useDraftAction';
import { contactName, text } from '@/features/chat/model/draftView';
import { executeHeader } from '@/features/chat/model/executeHeader';
import type { DraftRecord } from '@/features/chat/model/types';
import { Button } from '@/shared/ui';

import { DraftCardShell } from './DraftCardShell';
import { DraftField } from './DraftField';

export function ContactsDraftCard({ draft, draftKey }: { draft: DraftRecord; draftKey: string }) {
    const t = useTranslation();
    const state = useDraftAction(draftKey, draft.status);
    const create = draft.action === 'create';
    const label = create ? t('mobile.chat.draft_contact_new', 'New Contact') : t('mobile.chat.draft_contact_update', 'Update Contact');
    return (
        <DraftCardShell
            state={state}
            header={executeHeader(state, label, t('chat.draft.saving', 'Saving...'), t)}
            icon={create ? 'UserPlus' : 'Pencil'}
            tone={create ? 'success' : 'info'}
            title={contactName(draft, t)}
            titleIcon="UserPlus"
            actions={
                <Button
                    label={t('chat.draft.confirm', 'Confirm')}
                    iconName="Check"
                    size="sm"
                    loading={state.status === 'working'}
                    onPress={() => state.run(() => executeDraft('contacts', draft))}
                />
            }
        >
            {/* Icons and values only, as on the web: nothing here needs words. */}
            <DraftField icon="Mail" value={text(draft, 'email')} />
            <DraftField icon="Phone" value={text(draft, 'phone')} />
            <DraftField icon="Building2" value={text(draft, 'company')} />
            <DraftField icon="Briefcase" value={text(draft, 'jobTitle')} />
            <DraftField icon="StickyNote" value={text(draft, 'notes')} />
        </DraftCardShell>
    );
}
