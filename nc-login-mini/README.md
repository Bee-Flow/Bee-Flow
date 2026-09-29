# nc-login-mini — minimal Nextcloud ExApp

Proves NC's AppAPI auto-login works. One install, zero config.

- User opens NC → clicks the icon in the top bar → sees `Hi <their NC name>`.
- No login screen. No OAuth. No tenant key. No SaaS.

If this works, the larger Bee Flow connector's login issues live in the
SaaS/JWT chain, not in NC itself.

## Install (local sandbox)

Requires the `bf-appstore-test-nc` sandbox to be running (started via
`./scripts/deploy-all.sh appstore-test`).

```
cd nc-login-mini
./install.sh
```

This builds `nc-login-mini:dev`, unregisters any prior install, and
re-registers the ExApp via AppAPI. Takes ~15 seconds on a warm Docker cache.

Then open `http://localhost:18080`, click **NC Login Mini** in the top bar.
You should see your name immediately — no sign-in form.

## Files

- `appinfo/info.xml` — ExApp manifest (one USER route + lifecycle hooks)
- `src/server.js` — ~140 lines: heartbeat, init, embed, single GET page
- `Dockerfile` — node:22-alpine + express, ~50MB image
- `install.sh` — build + register one-shot

## Re-iterating

Edit `src/server.js`, then re-run `./install.sh`. AppAPI rebuilds the
container; NC keeps the menu entry registered.
