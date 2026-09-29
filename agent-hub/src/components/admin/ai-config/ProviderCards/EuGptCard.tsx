import React from 'react';
import ProviderApiKeyCard from './ProviderApiKeyCard';
import { PROVIDER_KEY_CONFIGS } from './providerKeyConfig';

type EuGptApiKeyCardProps = {
    onMessage?: (message: unknown) => void;
};

const EuGptApiKeyCard = ({ onMessage }: EuGptApiKeyCardProps) => (
    <ProviderApiKeyCard provider={PROVIDER_KEY_CONFIGS.eugpt} onMessage={onMessage} />
);

export default EuGptApiKeyCard;
