// Types for the JavaScript chat-model tier panel (ChatModelTiersConfig.jsx), so
// TypeScript callers see the real allModels shape instead of the inferred never[].
import type { ReactElement } from 'react';
import type { CatalogModel } from './chatModelTiers/tierTypes';

export interface ChatModelTiersConfigProps {
    allModels?: CatalogModel[];
}

export default function ChatModelTiersConfig(props: ChatModelTiersConfigProps): ReactElement;
