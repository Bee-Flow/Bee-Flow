// @typecheck strict
/**
 * Feature registrations: the one place the server fills core's registries
 * with what the features provide. Core may not require a feature
 * (server/ARCHITECTURE.md), so a capability core calls is injected: the
 * feature registers it here at boot, before any route or tick can need it.
 *
 *   boot/featureModules.js         feature modules core looks up by name -> core/featureModules.js
 *   integrations/toolFamilies.js   the core's tool families -> core/tools/toolFamilyRegistry.js
 *   integrations/runnerPorts.js    KB ingest (core/automationRunner/featurePorts.js)
 *   services/runnerPorts.js        the presentation renderer (core/automationRunner/featurePorts.js)
 *   integrations/integrationClients.js  the provider clients meeting notes and datatable
 *                                  sources use -> core/integrations/integrationClients.js
 *   projects/erasurePorts.js       account erasure's notebooks + content -> stores/user/erasurePorts.js
 *   boot/lateBoundPorts.js         lazy callbacks for setters a lower module exposes (load-order safe)
 *
 * Those are the core's files. A first-party module registers its own rows in its
 * firstParty/<id>.register.js (modules/firstParty/loader.js register), each group
 * contributed to the channel of the core file above it came from
 * (modules/firstParty/registrationChannels.js), and a module-owned registration file
 * as a whole to the channel of this file:
 *
 *   automation/runnerPorts.js      approvals, trigger bus, form queue, code sandbox, ...  (automation)
 *   jobs/runnerPorts.js            the retention and digest passes the runner ticks drive  (automation)
 *   core/meetingNotes/runnerPorts.js  the Meet/Teams/Talk passes the scheduler drives  (meetingNotes)
 *   core/cowork/runnerPorts.js     a Cowork plan's journey keeps its approved copy across a pause  (cowork)
 *   jobs/datatableChangePorts.js   the live-datatable listeners -> stores/datatableStore/liveChanges.js  (datatables)
 *
 * The module registrations are held while the core files load and run once they are in
 * (releaseModuleRegistration), inside the loader's failure fence: a module whose
 * registration throws is marked failed and the others carry on.
 *
 * Loaded by index.js, early. A test that drives the real code path through
 * one of these loads the registering module itself.
 */

'use strict';

const channels = require('../modules/firstParty/registrationChannels');

channels.holdModuleRegistration();
require('./featureModules');
require('../integrations/toolFamilies');
require('../integrations/runnerPorts');
require('../services/runnerPorts');
require('../integrations/integrationClients');
require('../projects/erasurePorts');
require('./lateBoundPorts');
channels.openChannel('boot/featureRegistrations');
channels.releaseModuleRegistration();
