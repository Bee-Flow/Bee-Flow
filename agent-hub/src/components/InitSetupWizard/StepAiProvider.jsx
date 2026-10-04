import React from 'react';
import { AzureOpenAILogo, OpenAILogo, GoogleAILogo, MistralLogo, ClaudeLogo } from './ProviderLogos';

const PROVIDERS = [
    { id: 'azure', label: 'Azure OpenAI', Logo: AzureOpenAILogo },
    { id: 'openai', label: 'OpenAI', Logo: OpenAILogo },
    { id: 'google', label: 'Google AI', Logo: GoogleAILogo },
    { id: 'mistral', label: 'Mistral', Logo: MistralLogo },
    { id: 'claude', label: 'Claude', Logo: ClaudeLogo },
];

const HELP_LINKS = {
    openai: 'Get your key from platform.openai.com',
    google: 'Get your key from Google AI Studio',
    mistral: 'Get your key from console.mistral.ai',
    claude: 'Get your key from console.anthropic.com',
};

const StepAiProvider = ({
    aiProvider, setAiProvider,
    azureEndpoint, setAzureEndpoint,
    azureKey, setAzureKey,
    azureModels, setAzureModels,
    genericKey, setGenericKey,
    clearMessages, inputClass, inputStyle,
}) => (
    <>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {PROVIDERS.map(p => (
                <button key={p.id} onClick={() => { setAiProvider(p.id); setGenericKey(''); clearMessages(); }}
                    className="p-3 rounded-xl border text-center transition-all hover:scale-[1.02]"
                    style={{
                        background: aiProvider === p.id ? 'rgba(99, 102, 241, 0.1)' : 'var(--bg-primary)',
                        borderColor: aiProvider === p.id ? 'var(--accent-primary)' : 'var(--border-default)',
                        color: 'var(--text-primary)',
                    }}>
                    <div className="flex justify-center mb-1.5"><p.Logo size={28} /></div>
                    <div className="text-xs font-medium">{p.label}</div>
                </button>
            ))}
        </div>

        {aiProvider === 'azure' && (
            <div className="space-y-3 pt-2">
                <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Azure Endpoint</label>
                    <input type="text" value={azureEndpoint} onChange={e => setAzureEndpoint(e.target.value)}
                        placeholder="https://your-resource.openai.azure.com"
                        className={inputClass} style={inputStyle} />
                </div>
                <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>API Key</label>
                    <input type="password" value={azureKey} onChange={e => setAzureKey(e.target.value)}
                        placeholder="Azure API Key"
                        className={inputClass} style={inputStyle} />
                </div>
                <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Deployment Names</label>
                    <input type="text" value={azureModels} onChange={e => setAzureModels(e.target.value)}
                        placeholder="gpt-5.6-terra, gpt-6-astra, gpt-4.1"
                        className={inputClass} style={inputStyle} />
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                        Comma-separated deployment names from your Azure portal. Use name=model when a deployment is not named after its model (e.g. prod-chat=gpt-6-astra).
                    </p>
                </div>
            </div>
        )}

        {aiProvider && aiProvider !== 'azure' && (
            <div className="pt-2">
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>API Key</label>
                <input type="password" value={genericKey} onChange={e => setGenericKey(e.target.value)}
                    placeholder={`${aiProvider.charAt(0).toUpperCase() + aiProvider.slice(1)} API Key`}
                    className={inputClass} style={inputStyle} />
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    {HELP_LINKS[aiProvider] || ''}
                </p>
            </div>
        )}
    </>
);

export default StepAiProvider;
