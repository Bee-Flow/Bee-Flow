/**
 * Which conditional tabs this session is offered (model/tabs.ts holds the
 * rules): only Meeting Notes is conditional, by that Studio section's gate.
 */

import { useAccess } from '@/core/access';

import { offersRecord } from '../model/gates';
import type { TabOffer } from '../model/tabs';

export function useTabOffer(): TabOffer {
    return { record: offersRecord(useAccess()) };
}
