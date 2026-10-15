import React from 'react';
import ProviderApiKeyCard from './ProviderApiKeyCard';
import type { ProviderCardProps } from './ProviderApiKeyCard';
import { PROVIDER_KEY_CONFIGS } from './providerKeyConfig';

const ElevenLabsApiKeyCard = ({ onMessage }: ProviderCardProps) => (
    <ProviderApiKeyCard provider={PROVIDER_KEY_CONFIGS.elevenlabs} onMessage={onMessage} />
);

export default ElevenLabsApiKeyCard;
