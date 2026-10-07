/** The org's member directory, read once the gate is open; it changes rarely. */

import { useQuery } from '@tanstack/react-query';

import { getMembers, memberKeys } from '../api/members';

export const useMembers = (enabled: boolean) =>
    useQuery({ queryKey: memberKeys.all, queryFn: ({ signal }) => getMembers(signal), enabled, staleTime: 5 * 60_000 });
