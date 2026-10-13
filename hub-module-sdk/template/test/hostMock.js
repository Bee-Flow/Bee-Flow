/**
 * Fake host object matching the hostApiVersion:2 surface.
 *
 * The surface (db, express, middleware, configStore, ai, usage, limits,
 * storage, webpages, net, log, isModuleActive, fetch) lives in the SDK's
 * shared test kit, hub-module-sdk/test-kit/hostMock.js; read it for every
 * option. This file binds your module's defaults. When you copy template/
 * elsewhere (e.g. to modules/<id>/), point the import below at the kit.
 *
 *   import { createModule } from '../server/src/index.js';
 *   import { makeHostMock } from './hostMock.js';
 *   const host = makeHostMock();
 *   const mod = createModule(host);
 *   await mod.stores[0].initDB();
 *   // drive mod.router with supertest, run mod.workers[0].tick(), etc.
 */

import express from 'express';
import { createHostMockFactory } from '../../test-kit/hostMock.js';

export const makeHostMock = createHostMockFactory({ express });

export default { makeHostMock };
