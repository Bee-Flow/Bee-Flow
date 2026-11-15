import { useTranslation } from '@/hooks/useTranslation';
import { CHIP } from '@/components/shared/adminUi';
import { orgRoleLabel } from './orgRoleLabel';

/**
 * A person's (or a group's, or an invitation's) organisation role as one quiet
 * theme chip, translated: the same words in the People list, the member rows,
 * the groups and the invitations.
 */
export default function OrgRoleChip({ role }: { role: string | null | undefined }) {
    const { t } = useTranslation();
    return <span className={CHIP} data-testid="people-role">{orgRoleLabel(t, role)}</span>;
}
