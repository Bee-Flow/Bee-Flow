import React from 'react';
import ProviderApiKeyCard, { type ApiKeyCardWrapperProps } from './ProviderApiKeyCard';
import { PROVIDER_KEY_CONFIGS } from './providerKeyConfig';

const ClaudeApiKeyCard = ({ onMessage }: ApiKeyCardWrapperProps) => (
    <ProviderApiKeyCard provider={PROVIDER_KEY_CONFIGS.claude} onMessage={onMessage} />
);

export default ClaudeApiKeyCard;
