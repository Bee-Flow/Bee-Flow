// Who can be named in a comment: the project's people (from the members
// endpoint, through the team chat's directory) plus the AI. Also the display
// name for an author id, and the tokens the text paints as mentions.

import { useMemo } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useChatPeople } from '../projects/workspace/chat/chatPeople';
import type { MentionCandidate } from '../projects/workspace/chat/mentions';
import type { WorkspaceUser } from '../projects/workspace/types';

export interface CommentPeople {
    nameOf: (userId: string | null | undefined) => string;
    candidates: MentionCandidate[];
    tokens: string[];
}

export function useCommentPeople(projectId: string, currentUser: WorkspaceUser | null): CommentPeople {
    const { t } = useTranslation();
    const people = useChatPeople(projectId, currentUser);
    const aiName = t('comments.ai_name', 'AI assistant');
    return useMemo(() => {
        const candidates: MentionCandidate[] = people.people
            .filter(p => p.id !== currentUser?.id)
            .map(p => ({ key: p.id, kind: 'user', label: p.name, token: p.name, userId: p.id }));
        candidates.push({ key: 'ai', kind: 'ai', label: aiName, token: 'ai' });
        return { nameOf: people.nameOf, candidates, tokens: ['ai', 'assistant', ...candidates.map(c => c.token)] };
    }, [people, currentUser?.id, aiName]);
}
