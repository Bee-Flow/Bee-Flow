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
file a `description` (what the step does): its first sentence is the gloss in that index (at most
72 characters, no `;`), and the whole of it follows the field list in the full entry.

A server kind is refused on the anonymous step route of a public page unless its policy says
`public: 'step'` (`usecases/studioAppPublicStepGate.mts`): 'refuse', 'browser' and 'stream' all keep
it out of the plain step executor.

`../../catalogContract.test.js` holds every file here to the rules (an answer for every execution
form, declared slots, a description whose first sentence fits the index, the executor file of a
server kind) and needs no edit for a new kind. `../README.md` lists every other place a `since`
mark can sit.

Only `.js` files belong here: the web and phone tests load this directory as plain CommonJS.
