/**
 * Feature registrations: the one place the server fills core's registries
 * with what the features provide. Core may not require a feature
 * (server/ARCHITECTURE.md), so a capability core calls is injected: the
 * feature registers it here at boot, before any route or tick can need it.
 *
 *   integrations/toolFamilies.js   every integration's tools -> core/tools/toolFamilyRegistry.js
 *   automation/runnerPorts.js      approvals, trigger bus, form queue, code sandbox, ...
 *   jobs/runnerPorts.js            the retention and digest passes the runner ticks drive
 *   integrations/runnerPorts.js    the Nextcloud admin bell, KB ingest, custom-integration auth
 *   services/runnerPorts.js        the presentation renderer
 *   core/meetingNotes/runnerPorts.js  the Meet/Teams/Talk passes the scheduler drives
 *                                  (all five -> core/automationRunner/featurePorts.js)
 *   integrations/integrationClients.js  the provider clients meeting notes and datatable
 *                                  sources use -> core/integrations/integrationClients.js
 *   jobs/datatableChangePorts.js   the live-datatable listeners -> stores/datatableStore/liveChanges.js
 *   projects/erasurePorts.js       account erasure's notebooks + projects -> stores/user/erasurePorts.js
 *
 * Loaded by index.js, early. A test that drives the real code path through
 * one of these loads the registering module itself.
 */

'use strict';

require('../integrations/toolFamilies');
require('../automation/runnerPorts');
require('../jobs/runnerPorts');
require('../integrations/runnerPorts');
require('../services/runnerPorts');
require('../core/meetingNotes/runnerPorts');
require('../integrations/integrationClients');
require('../jobs/datatableChangePorts');
require('../projects/erasurePorts');
