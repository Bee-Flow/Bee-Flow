import React from 'react';
import ProviderApiKeyCard from './ProviderApiKeyCard';
import type { ProviderMessage } from '@/hooks/useProviderConfig';
import { PROVIDER_KEY_CONFIGS } from './providerKeyConfig';

type EuGptApiKeyCardProps = {
    onMessage?: (message: ProviderMessage) => void;
};

const EuGptApiKeyCard = ({ onMessage }: EuGptApiKeyCardProps) => (
    <ProviderApiKeyCard provider={PROVIDER_KEY_CONFIGS.eugpt} onMessage={onMessage} />
);

export default EuGptApiKeyCard;
