/** The hub's gate for a screen: open, pending, denied or locked with the line it shows. */

import { useAccess } from '@/core/access';
import { useTranslation } from '@/core/i18n';

import { complianceAccess, lockedHint, type ComplianceAccess } from '../model/access';

export interface ComplianceGate {
    access: ComplianceAccess;
    open: boolean;
    hint: string;
}

export function useComplianceAccess(): ComplianceGate {
    const t = useTranslation();
    const snapshot = useAccess();
    const access = complianceAccess(snapshot);
    return { access, open: access.state === 'open', hint: lockedHint(access, snapshot, t) };
}
