import { useTranslation } from '@/hooks/useTranslation';
import Toggle from '@/components/shared/Toggle';

interface AutoApproveCardProps {
    autoApprove: boolean;
    saving: boolean;
    onToggle: () => void;
}

/**
 * The org's auto-approve switch. Only meaningful when the org's sign-in
 * method is an external provider (Google/Microsoft); the caller decides
 * whether to show it.
 */
export default function AutoApproveCard({ autoApprove, saving, onToggle }: AutoApproveCardProps) {
    const { t } = useTranslation();
    return (
        <Toggle
            className="mb-4"
            checked={autoApprove}
            onChange={() => onToggle()}
            disabled={saving}
            label={t('org.auto_approve_sso')}
            description={t('org.auto_approve_desc')}
        />
    );
}
