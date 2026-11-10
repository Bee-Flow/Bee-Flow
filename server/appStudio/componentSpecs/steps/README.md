# Step registry

One file per step kind added after the base catalogue: `<kind>.js`. The files are read in sorted
order and loaded after the base kinds (`../stepRegistry.js` says what a file exports and checks it
at load). A server kind also has its executor in `../../actionExecutor/steps/<kind>.mts`
(`export async function runStep(app, model, step, ctx)`), and the editor shows a kind through
`agent-hub/src/components/admin/Studio/AppStudio/flow/steps/<kind>.ts`.

After adding or changing a file: `node server/appStudio/stepKindsGen.mts`, then `npm run gen:shared`.

Only `.js` files belong here: the web and phone tests load this directory as plain CommonJS.
