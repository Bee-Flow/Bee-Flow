// Result of a "Test connection" probe against a self-hosted runtime.
//
// Reachability alone isn't the useful answer — an admin wants to know what the
// box is actually serving, because that is what will (or won't) appear in the
// tier picker. So a successful probe lists the model ids it found.

import type { ProbeData } from '@/api/runtimeTypes';
import { CHIP, CHIP_INFO } from '@/components/shared/adminUi';
import { useTranslation } from '@/hooks/useTranslation';

const MAX_SHOWN = 12;

interface ProbeResultProps {
    result: ProbeData | null;
}

const ProbeResult = ({ result }: ProbeResultProps) => {
    const { t } = useTranslation();
    if (!result) return null;

    if (!result.ok) {
        return (
            <p className="mt-2 text-xs text-[var(--error-ink)]">
                ✕ {result.error || t('admin_ai_config.probe_unreachable', 'Could not reach that address')}
            </p>
        );
    }

    const extra = result.models.length - MAX_SHOWN;
    return (
        <div className="mt-2">
            <p className="text-xs text-[var(--success-ink)]">
                {t('admin_ai_config.probe_reachable', '✓ Reachable')}{result.version ? ` (v${result.version})` : ''}: {result.modelCount === 1 ? t('admin_ai_config.model_count_one', '1 model') : t('admin_ai_config.model_count_other', '{count} models', { count: result.modelCount })}
                {result.error ? `. ${result.error}` : ''}
            </p>
            {result.models?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                    {result.models.slice(0, MAX_SHOWN).map((m) => (
                        <span key={m.id} className={m.cat === 'Embedding' || m.cat === 'Rerank' ? CHIP_INFO : CHIP}>
                            {m.id}
                        </span>
                    ))}
                    {extra > 0 && (
                        <span className="px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
                            {t('admin_ai_config.probe_more', '+{extra} more', { extra })}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};

export default ProbeResult;
