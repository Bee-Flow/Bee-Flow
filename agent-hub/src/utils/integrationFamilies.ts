// The integration ids that make up a provider family on the client, in one
// place so Settings > Connections and the admin pages cannot drift apart.
//
//   GOOGLE_APP_IDS     the Google Workspace apps whose presence shows the
//                      Google Workspace connect tile (Settings > Connections)
//   MICROSOFT_APP_IDS  the Microsoft 365 apps whose presence shows the
//                      Microsoft 365 group
//
// The server's family lists (usecases/integrations/orgIntegrationAvailability.mts)
// hold every Google app; these are the ones the connect tile follows.

export const GOOGLE_APP_IDS: readonly string[] = Object.freeze(['gmail', 'google-calendar', 'google-drive']);

export const MICROSOFT_APP_IDS: readonly string[] = Object.freeze(['outlook', 'outlook-readonly', 'ms-calendar', 'onedrive', 'ms-contacts']);
