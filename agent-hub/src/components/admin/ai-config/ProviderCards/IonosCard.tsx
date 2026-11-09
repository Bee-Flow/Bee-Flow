import React from 'react';
import ProviderApiKeyCard from './ProviderApiKeyCard';
import type { ProviderCardProps } from './ProviderApiKeyCard';
import { PROVIDER_KEY_CONFIGS } from './providerKeyConfig';
import { useTranslation } from '@/hooks/useTranslation';

const IonosApiKeyCard = ({ onMessage }: ProviderCardProps) => {
    const { t } = useTranslation();
    return (
    <ProviderApiKeyCard provider={PROVIDER_KEY_CONFIGS.ionos} onMessage={onMessage}>
        <p className="text-xs mt-2 text-[var(--text-muted)]">
            {t('admin_ai_config.ionos_hint', 'Open-weight models hosted by IONOS in Germany (AI Model Hub): chat, embeddings and reranking, billed per token. Reranking is set up separately under Reranker.')}
        </p>
    </ProviderApiKeyCard>
    );
};

export default IonosApiKeyCard;
