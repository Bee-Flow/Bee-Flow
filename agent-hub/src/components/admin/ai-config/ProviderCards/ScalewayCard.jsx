import React from 'react';
import ProviderApiKeyCard from './ProviderApiKeyCard';
import { PROVIDER_KEY_CONFIGS } from './providerKeyConfig';

// One Scaleway secret key opens every Scaleway API, so this is the same key the
// Whisper transcription integration uses (Admin → Integrations → Transcription).
// Saving it here also enables that, and vice versa — worth saying out loud so
// an admin does not go looking for a second key to create.
const ScalewayApiKeyCard = ({ onMessage }) => (
    <ProviderApiKeyCard provider={PROVIDER_KEY_CONFIGS.scaleway} onMessage={onMessage}>
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Serverless open-weight models (Qwen, Mistral, Gemma, GLM, DeepSeek, gpt-oss)
            served from EU data centres and billed per token. The same secret key is used
            for Scaleway Whisper transcription under Integrations.
        </p>
    </ProviderApiKeyCard>
);

export default ScalewayApiKeyCard;
