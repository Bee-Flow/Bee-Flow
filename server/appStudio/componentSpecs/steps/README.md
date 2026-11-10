# Step registry

One file per step kind added after the base catalogue: `<kind>.js`. The files are read in sorted
order and loaded after the base kinds (`../stepRegistry.js` says what a file exports and checks it
at load). A server kind also has its executor in `../../actionExecutor/steps/<kind>.mts`
(`export async function runStep(app, model, step, ctx)`), and the editor shows a kind through
`agent-hub/src/components/admin/Studio/AppStudio/flow/steps/<kind>.ts`.

After adding or changing a file: `npm run gen:shared` (it rewrites `server/shared/appDefinition/stepKinds.generated.mjs`
and the browser's copy; `npm run lint:shared-mirror`, part of `check:fast`, fails on a stale one).

The AI builder's prompt does not render a registry kind: it lists the kind in its extension index
and serves the full field list through `app_inspect_catalog` (`../../catalogTiers.mts`). Give the
file an optional `description` (one sentence, what the step does): its first sentence is the gloss
in that index, and the whole of it follows the field list in the full entry.

Only `.js` files belong here: the web and phone tests load this directory as plain CommonJS.
