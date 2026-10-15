import React from 'react';
import ProviderApiKeyCard, { type ApiKeyCardWrapperProps } from './ProviderApiKeyCard';
import { PROVIDER_KEY_CONFIGS } from './providerKeyConfig';

const ElevenLabsApiKeyCard = ({ onMessage }: ApiKeyCardWrapperProps) => (
    <ProviderApiKeyCard provider={PROVIDER_KEY_CONFIGS.elevenlabs} onMessage={onMessage} />
);

export default ElevenLabsApiKeyCard;
