/**
 * Feature registrations: the one place the server fills core's registries
 * with what the features provide. Core may not require a feature
 * (server/ARCHITECTURE.md), so a capability core calls is injected: the
 * feature registers it here at boot, before any route or tick can need it.
 *
 *   integrations/toolFamilies.js   every integration's tools -> core/tools/toolFamilyRegistry.js
 *   automation/runnerPorts.js      approvals, trigger bus, form queue, evolution
 *                                  -> core/automationRunner/featurePorts.js
 *   jobs/runnerPorts.js            the retention and digest passes the runner ticks drive
 *
 * Loaded by index.js, early. A test that drives the real code path through
 * one of these loads the registering module itself.
 */

'use strict';

require('../integrations/toolFamilies');
require('../automation/runnerPorts');
require('../jobs/runnerPorts');
