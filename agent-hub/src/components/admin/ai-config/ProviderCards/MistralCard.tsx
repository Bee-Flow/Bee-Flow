import React from 'react';
import ProviderApiKeyCard, { type ApiKeyCardWrapperProps } from './ProviderApiKeyCard';
import { PROVIDER_KEY_CONFIGS } from './providerKeyConfig';

const MistralApiKeyCard = ({ onMessage }: ApiKeyCardWrapperProps) => (
    <ProviderApiKeyCard provider={PROVIDER_KEY_CONFIGS.mistral} onMessage={onMessage} />
);

export default MistralApiKeyCard;
