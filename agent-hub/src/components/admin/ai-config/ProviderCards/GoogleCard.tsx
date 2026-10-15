import React from 'react';
import ProviderApiKeyCard, { type ApiKeyCardWrapperProps } from './ProviderApiKeyCard';
import { PROVIDER_KEY_CONFIGS } from './providerKeyConfig';

const GoogleApiKeyCard = ({ onMessage }: ApiKeyCardWrapperProps) => (
    <ProviderApiKeyCard provider={PROVIDER_KEY_CONFIGS.google} onMessage={onMessage} />
);

export default GoogleApiKeyCard;
