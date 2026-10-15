// Types for the JavaScript embeddings card, so TypeScript callers see its
// real props (the .jsx infers them from its own body, where `allModels`
// comes out as never[]).
import type { ReactElement } from 'react';
import type { CatalogModel } from './chatModelTiers/tierTypes';
import type { ProviderSummary } from './ProviderCards/local/localRuntimeApi';

export interface EmbeddingsConfigProps {
    providers: ProviderSummary[];
    allModels: CatalogModel[];
    fetchAllModels: () => void;
}

export default function EmbeddingsConfig(props: EmbeddingsConfigProps): ReactElement;
