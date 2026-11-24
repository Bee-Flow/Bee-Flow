// The Teamwork helper (server/usecases/coworkDeskHelper.mts, coworkDeskHelperApply.mts): a proposal of a desk from the
// person's own words, and setting it up through the desk's own rules. Setting it up changes desks, so every desk read
// is read again afterwards.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

interface HelperChainStep { scheduleId: string | null; title: string | null; ownerName: string | null; mine: boolean; words: string }
interface HelperRole { role: string; holderId: string | null; holderName: string | null; standInId: string | null; standInName: string | null; holderWords: string }
export interface HelperCowork { scheduleId: string; title: string; ownerName: string; mine: boolean }
export interface HelperPerson { id: string; name: string; me: boolean }
export interface DeskProposal {
    /** False: the helper could not work it out, and the person chooses by hand from the same lists. */
    drafted: boolean;
    /** The desk it changes, or null for a new desk. */
    deskId: string | null;
    deskName: string;
    chain: HelperChainStep[];
    roles: HelperRole[];
    /** The person's words that matched no cowork or person. */
    unmatched: string[];
    choices: { coworks: HelperCowork[]; people: HelperPerson[] };
}
export interface DeskDraftBody { deskName: string; chain: string[]; roles: Array<{ role: string; holderId: string; standInId?: string | null }> }
type HelperNoteKind = 'desk_made' | 'added' | 'starts_after' | 'role_set' | 'invited' | 'their_start' | 'allow' | 'start_later' | 'needs_runner' | 'not_done';
export interface HelperNote {
    kind: HelperNoteKind;
    title?: string; afterTitle?: string; who?: string; role?: string; holderName?: string; standInName?: string | null; reason?: string; allowedByYou?: boolean;
    /** their_start: the invitation carries the start, so accepting it is all the colleague does. */
    planned?: boolean;
}
export interface HelperResult { deskId: string; done: HelperNote[]; waiting: HelperNote[] }

/** Ask the helper for a proposal. It makes nothing. */
export function useDraftDesk() {
    return useMutation<DeskProposal, Error, { text: string; itemId?: string }>({
        mutationFn: (body) => apiJson<'POST /api/cowork/desks/helper/draft', DeskProposal>('POST /api/cowork/desks/helper/draft', { body }),
    });
}

/** Set the proposal up, as the person; afterwards every desk read is read again. */
export function useApplyDeskDraft() {
    const client = useQueryClient();
    return useMutation<HelperResult, Error, { itemId?: string; draft: DeskDraftBody }>({
        mutationFn: (body) => apiJson<'POST /api/cowork/desks/helper/apply', HelperResult>('POST /api/cowork/desks/helper/apply', { body }),
        onSuccess: () => { void client.invalidateQueries({ queryKey: ['cowork', 'desks'] }); },
    });
}
