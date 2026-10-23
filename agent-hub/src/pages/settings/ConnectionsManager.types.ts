import type { HttpAuthType } from '../../utils/httpCredentialTypes';
import type React from 'react';

export interface ProviderField { key: string; label: string; labelKey: string; type: string; }

export interface ProviderSpec {
    id: string; name: string; kind?: string; fields?: ProviderField[]; authTypes?: HttpAuthType[];
}

export interface ConnectionSecretMeta {
    headerName?: string; tokenUrl?: string; clientIdHint?: string; username?: string; scope?: string;
}

export interface Connection {
    id: string; provider: string; label: string; kind: string; isDefault: boolean; secretMeta: ConnectionSecretMeta;
}

export interface Grant {
    id: string; connection_id: string; grantee_type: string; grantee_label?: string;
    resource_type?: string; expires_at?: string;
}

export interface GroupLabelProps {
    children?: React.ReactNode;
}

export interface ErrorLineProps {
    children?: React.ReactNode;
}

export interface SharePanelProps {
    connection: Connection;
    grants: Grant[];
    onChanged: () => void;
}

export interface ConnectionRowProps {
    connection: Connection;
    grants: Grant[];
    onChanged: () => Promise<void>;
}

export interface AddConnectionFormProps {
    onAdded: () => Promise<void>;
}
