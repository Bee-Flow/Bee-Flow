import type { HubUser } from './AgentHub/useAgentHubData.types';

/** The signed-in user, plus the identity and flag fields the shell reads. */
export type AuthedUser = HubUser & { isConsumerAccount?: boolean; organizationId?: string; orgId?: string; featureFlags?: { deploymentMode?: string; meeting_notes?: boolean } };
export type { HubUser } from './AgentHub/useAgentHubData.types';
export type { StudioRoute } from './AgentHub/studioRouteProps';
export type { PendingNcBinding } from './components/integrations/nextcloud/NcBindingApprovalModal';
