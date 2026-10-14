import { Users } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';

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
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 mb-4">
            <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-[var(--accent-primary)]" />
                        <span className="text-sm font-semibold text-[var(--text-primary)]">{t('org.auto_approve_sso')}</span>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-1 ml-6">
                        {t('org.auto_approve_desc')}
                    </p>
                </div>
                <button
                    onClick={onToggle}
                    disabled={saving}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${autoApprove ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-default)]'} ${saving ? 'opacity-60 cursor-wait' : ''}`}
                >
                    <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${autoApprove ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                </button>
            </div>
        </div>
    );
}
