// Default Vite config used when a project ships none. Enables React fast-refresh
// + JSX, binds all interfaces (the container is on an isolated network), and
// accepts the reverse-proxy host. A project that needs custom Vite config can
// commit its own vite.config.* and the entrypoint will prefer it — NOTE that
// such a project won't automatically pick up VITE_BASE_PATH below, so its
// asset/HMR URLs may break behind the sub-path proxy until it's updated to
// read the same env var (see server/webpage-runner/README.md).
import react from '@vitejs/plugin-react';

export default {
    plugins: [react()],
    // webpageRuntimeManager.js sets this to the exact path the reverse proxy
    // (server/routes/webpagesFullTierProxy.js) mounts this project's container
    // at, e.g. /api/webpages-preview/<id>/full/ — without it, Vite emits
    // root-relative asset/HMR URLs that resolve against the wrong origin path
    // once served through a sub-path proxy. Defaults to '/' for local (non-
    // proxied) `vite` usage outside the container.
    base: process.env.VITE_BASE_PATH || '/',
    server: {
        host: true,
        port: Number(process.env.PORT) || 5173,
        strictPort: true,
        // The dev server sits behind Bee Flow's reverse proxy on an isolated
        // network; allow any Host header so proxied requests aren't rejected.
        allowedHosts: true,
        // HMR is proxied over the app's TLS endpoint; ops sets the public port.
        hmr: { clientPort: Number(process.env.HMR_CLIENT_PORT) || 443 },
    },
};
