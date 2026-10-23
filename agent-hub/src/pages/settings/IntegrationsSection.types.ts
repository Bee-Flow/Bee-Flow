import type React from 'react';
import type { UserSettingSaveResult } from '../../hooks/useUserSettingSave';
import type { McpServerSource } from '../../components/apps/appCatalog';
import type { SettingsStatuses, SettingsUser } from './shell/settingsShellTypes';

export interface GroupLabelProps {
    children?: React.ReactNode;
}

export interface IntegrationRowProps {
    icon: React.ReactNode;
    name: string;
    description: string;
    connected?: boolean;
    badge?: React.ReactNode;
    children?: React.ReactNode;
    last?: boolean;
}

export interface ApiKeyFieldProps {
    placeholder: string;
    value: string;
    onChange: React.ChangeEventHandler<HTMLInputElement, HTMLInputElement>;
    onSave: (() => Promise<void>) | (() => void);
    saving: boolean;
    hint?: string | React.JSX.Element;
    canSave?: boolean;
}

export interface DisconnectButtonProps {
    onDisconnect: (() => Promise<UserSettingSaveResult>) | (() => Promise<void>) | (() => void);
    disconnecting: boolean;
}

export interface FirefliesIntegrationProps {
    hasFirefliesKey: boolean;
    onSaved: () => void;
    last: boolean;
}

export interface YouTrackIntegrationProps {
    hasYouTrackConfig?: boolean;
    onSaved: () => void;
    last: boolean;
}

export interface SignRequestIntegrationProps {
    hasSignRequestConfig?: boolean;
    onSaved: () => void;
    last: boolean;
}

export interface GammaIntegrationProps {
    hasGammaKey: boolean;
    onSaved: () => void;
    last: boolean;
}

export interface AFASIntegrationProps {
    hasAfasConfig?: boolean;
    onSaved: () => void;
    last: boolean;
}

export interface VplanIntegrationProps {
    hasVplanConfig?: boolean;
    onSaved: () => void;
    last: boolean;
}

export interface NMBRSIntegrationProps {
    hasNmbrsConfig?: boolean;
    apiMode?: string;
    subdomain?: string;
    email?: string;
    env?: string;
    onSaved: () => void;
    last: boolean;
}

export interface GoogleWorkspaceIntegrationProps {
    onSaved: () => void;
    last: boolean;
}

export interface LinkedInIntegrationProps {
    connected?: boolean;
    linkedInName?: string;
    hasLinkedInConfig?: boolean;
    onSaved: () => void;
    last: boolean;
}

export interface WithingsIntegrationProps {
    onSaved: () => void;
    last: boolean;
}

export interface GitHubIntegrationProps {
    onSaved: () => void;
    last: boolean;
}

export interface NextcloudIntegrationProps {
    hasNextcloudAppPassword?: boolean;
    isNextcloudUser?: boolean;
    nextcloudUrl?: string;
    isConnectorUser: boolean;
    onSaved: () => void;
    last: boolean;
}

export interface McpCredential {
    key: string;
    label?: string;
    description?: string;
    configured?: boolean;
}

export type McpCredentialServer = McpServerSource & { credentials: McpCredential[] };

export interface McpCredentialRowsProps {
    servers: McpCredentialServer[];
    reload: () => Promise<void>;
    onSaved?: () => void;
    last: boolean;
}

export interface IntegrationGroupProps {
    label: string;
    rows: (false | '' | [string, (last: boolean) => React.ReactNode])[];
}

export interface IntegrationsSectionProps {
    statuses: SettingsStatuses;
    onSaved: (key: string) => void;
    user: SettingsUser | null | undefined;
}
