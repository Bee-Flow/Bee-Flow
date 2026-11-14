/**
 * Zinnen die meerdere Nederlandse koppelingspagina's delen (zie index.mts).
 */

export const NC_CONNECT = 'Bee Flow bereikt je Nextcloud op twee manieren: binnen Nextcloud via de Nextcloud-connector, of van buitenaf met je eigen Nextcloud-aanmelding (OAuth) of een app-wachtwoord. In beide gevallen draait elke tool als de persoon die hem gebruikt. De assistent ziet en wijzigt dus alleen wat jij in Nextcloud mag zien en wijzigen.';
export const ncApp = (app: string): string => `Werkt alleen als de app ${app} in je Nextcloud staat. Chat en agents bieden deze tools pas aan als je Nextcloud meldt dat de app is geïnstalleerd.`;
export const NC_APP_PASSWORD = 'Zonder de connector hebben deze tools een app-wachtwoord nodig: alleen een Nextcloud-aanmelding via OAuth is daarvoor niet genoeg.';
export const GOOGLE_CONNECT = 'Je koppelt je eigen Google-account onder Instellingen, Verbindingen, met de aanmelding van Google zelf (OAuth). De assistent werkt daarna met de rechten van dat account en niet meer. Een beheerder van de Bee Flow-server registreert de Google OAuth-app één keer.';
export const MS_CONNECT = 'Je koppelt je eigen Microsoft 365-account onder Instellingen, Verbindingen, of je meldt je bij Bee Flow aan met Microsoft. De tools werken via Microsoft Graph met de rechten van dat account. Een beheerder registreert Bee Flow één keer als app in Microsoft Entra.';
export const OWN_KEY = 'De gegevens worden per persoon versleuteld opgeslagen. De verbinding is niet uit te lenen: niemand anders kan jouw sleutel gebruiken.';
export const PREVIEW = 'In een chat zie je eerst een voorbeeld en keur je het goed voordat er iets wordt aangemaakt, gewijzigd of verwijderd.';
export const MS_PUSH = 'Microsoft stuurt de gebeurtenissen zelf door, dus daarvoor moet de Bee Flow-server voor Microsoft bereikbaar zijn.';
