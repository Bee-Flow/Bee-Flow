// @typecheck strict
/**
 * The integrations' side of core/integrations/integrationClients.js: the
 * provider clients that core's meeting notes and datatable sources, the
 * automation feature's approval delivery and trigger sources, and the test
 * generator (services/testGenerator.js) talk through, registered so that none
 * of them requires the integration.
 *
 * Every client belongs to a first-party module (Google, Microsoft, Nextcloud,
 * the SaaS integrations), so each is registered in that module's
 * firstParty/<id>.register.js, contributed to the channel
 * 'integrations/integrationClients' (modules/firstParty/registrationChannels.js)
 * that this file opens. Requiring this file is still how a caller makes sure the
 * clients are registered: loaded at boot by boot/featureRegistrations.js, and by
 * the code and tests that look a client up. Each client is a getter, so nothing
 * is loaded until core first asks for it.
 */

'use strict';

require('../modules/firstParty/registrationChannels').openChannel('integrations/integrationClients');
