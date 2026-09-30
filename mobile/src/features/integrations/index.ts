/** Integrations: linked accounts and the model's tool allow-list. Import from '@/features/integrations'. */

export { IntegrationsScreen } from './screens/IntegrationsScreen';

// The catalogue and the org's allow-list, for screens that grant apps to
// something else (a skill's "may use").
export { INTEGRATION_CATALOG, allowedByOrg, connectorLabel } from './model/catalog';
export { useUserSettings } from './hooks/queries';
export { useSaveEnabledApps } from './hooks/mutations';
export type { CatalogEntry, UserSettings } from './model/types';
