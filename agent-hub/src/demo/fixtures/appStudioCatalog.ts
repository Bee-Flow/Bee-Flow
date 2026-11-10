/**
 * The demo's answer to GET /api/studio-apps/catalog: buildCatalog() in
 * server/appStudio/componentSpecs.js, written to appStudioCatalog.generated.json
 * by scripts/gen-app-catalog.mjs (`npm run gen:shared`; lint:shared-mirror
 * fails when it is stale). Do not edit the JSON by hand.
 *
 * WHY A SNAPSHOT AND NOT AN IMPORT: the server module cannot be imported into
 * the client bundle, and the demo must answer without the network. The editor
 * palette comes from the CLIENT componentRegistry, so the catalog is only read
 * for palette card descriptions (ComponentRibbon), the generic inspector prop
 * specs (SpecPanel), computed-props specs and mailbox table templates.
 *
 * `components` is restricted to the types the fixture app uses plus the ones a
 * visitor is most likely to drop (DEMO_TYPES in the generator); everything else
 * in the object is the full catalog.
 */
import catalog from './appStudioCatalog.generated.json';

export const DEMO_CATALOG = catalog;
