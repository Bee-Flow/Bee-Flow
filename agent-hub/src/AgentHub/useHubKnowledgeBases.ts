import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { knowledgeBaseListOptions } from '../api/queries/hubData';
import { directChatKbList, type KbRow } from '../components/chat/knowledgeBaseClaim';

/**
 * The knowledge bases the direct-chat picker offers.
 *
 * The list is read the first time direct chat is active, so the composer's
 * picker has data without the user opening the store first. Did GET /api/kb
 * ever actually ANSWER? `data` is undefined before the first answer and stays
 * undefined when one is refused, so the list alone could not tell "this user
 * has no knowledge bases" from "we never got to ask" - and the composer's KB
 * pill has to tell those apart (it reads null as "say nothing", never as
 * "none"). Only a readable array makes the list known, and a later failed
 * refresh leaves the last known list in place.
 *
 * The picker only sees KBs whose usage_contexts include 'direct_chat'; the
 * Knowledge Bases marketplace shows the full list.
 */
export default function useHubKnowledgeBases(directChatMode: boolean) {
    const query = useQuery({ ...knowledgeBaseListOptions<KbRow>(), enabled: directChatMode });
    const kbs = query.data;
    const directChatKbs = useMemo(() => directChatKbList(kbs ?? [], kbs !== undefined), [kbs]);
    return { directChatKbs };
}
