/**
 * Sentences that several English integration pages share (see index.mts).
 */

export const NC_CONNECT = 'Bee Flow reaches your Nextcloud in one of two ways: inside Nextcloud through the Nextcloud connector, or from outside with each person\'s own Nextcloud sign-in (OAuth) or an app password. Either way every tool runs as the person who uses it, so the assistant only sees and changes what that person may see and change in Nextcloud.';
export const ncApp = (app: string): string => `Needs the ${app} app in your Nextcloud. Chat and agents only offer these tools when your Nextcloud reports that the app is installed.`;
export const NC_APP_PASSWORD = 'Without the connector these tools need an app password: a Nextcloud sign-in through OAuth alone is not enough for them.';
export const GOOGLE_CONNECT = 'Each person connects their own Google account under Settings, Connections, with Google\'s own sign-in (OAuth). The assistant then works with that account\'s access and nothing more. An administrator of the Bee Flow server registers the Google OAuth app once.';
export const MS_CONNECT = 'Each person connects their own Microsoft 365 account under Settings, Connections, or signs in to Bee Flow with Microsoft. The tools work with that account\'s access through Microsoft Graph. An administrator registers Bee Flow once as an app in Microsoft Entra.';
export const OWN_KEY = 'The values are stored per person and encrypted at rest. The connection is not lendable: nobody else can use your key.';
export const PREVIEW = 'In a chat you see a preview and approve it before anything is created, changed or deleted.';
