---
title: Several stacks on one machine
---

# Several stacks on one machine

One VM, several Bee Flow servers: for example a group of companies that wants one Bee Flow that is
reachable from the internet and one, for the companies with sensitive data, that is reachable from
the office network only — without buying a VM per company. The stacks share nothing but the host
and, if you want, the CPU-heavy sidecars (PII guard, topic classifier, Ollama).

## When to use this, and when not

Bee Flow is multi-tenant: one server holds many organisations, each with its own members, data and
settings. For companies that merely want to be apart, **organisations in one stack** are the right
tool. A second stack is for a harder boundary:

- the stacks have different exposure: one is open to the internet (public pages, webhooks, MCP
  tokens, external users), the other must never be — a bug in the first must not be a door into
  the second;
- the stacks have different operators, backup regimes or retention rules;
- an audit asks for a separate database, a separate encryption master key and a separate process,
  not a separate row in a table.

Each stack has its own PostgreSQL, object storage, browser sidecar, `MASTER_ENCRYPTION_KEY`,
`SESSION_SECRET`, admin account and licence key (a licence is per server). Count on ~4 GB of RAM per
stack, plus the sidecars.

## The shape

```
internet ──443──> reverse proxy, public IP   ──> 127.0.0.1:5176  (stack "public")
LAN / VPN ──443──> reverse proxy, internal IP ──> 127.0.0.1:5276  (stack "internal")

Docker networks:
  public-network        public-server, public-postgres, public-rustfs, public-browser, …
  internal-network      internal-server, internal-postgres, …
  public-sidecars       guard, classify  <->  public-server        (internal, no egress)
  internal-sidecars     guard, classify  <->  internal-server      (internal, no egress)
```

Three compose projects: one per stack from `docker-compose.from-registry.yml` (`STACK_NAME=…
./selfhost.sh`) and one for the sidecars from `docker-compose.sidecars.yml`
(`./selfhost-sidecars.sh`). The sidecar containers sit on every stack's sidecar network; a stack's
server sits only on its own. **The two servers never share a network**, so the internet-facing
one cannot address the other's API, database or storage, however it is compromised.

What is shared and why that is safe:

| Service | Shared? | Why |
|---------|:-------:|-----|
| Guard (PII detection) | yes | Stateless. Its Redis cache holds offsets, labels and scores under HMAC keys — never text. The shared compose file logs at `WARNING` so request content stays out of the one log both stacks feed. |
| Classifier | yes | Stateless, model baked into the image, no cache. |
| Ollama | optional | Keeps no prompts. One copy of each model in memory. |
| PostgreSQL, object storage | **no** | Each stack's data, each stack's keys. |
| Browser sidecar | **no** | Holds session state and a per-stack secret path. |
| Redis session cache (`REDIS_URL`) | **no** | Leave it empty (sessions live in PostgreSQL) or give a stack its own Redis. |

## Step by step

All commands run in one directory holding `selfhost.sh`, `selfhost-sidecars.sh`, the compose files
and the two `.env.*.example` templates. The plain install (`./selfhost.sh` without `STACK_NAME`)
may live there too; it is untouched by any of this.

### 1. The shared sidecars

```bash
SIDECAR_STACKS="public internal" PROFILES="guard classify" ./selfhost-sidecars.sh
```

First run: creates `.env.sidecars` with a generated `SERVICES_API_KEY`, generates
`docker-compose.sidecars.networks.yml` (one internal network per stack in `SIDECAR_STACKS`), pulls
and starts the sidecars, waits for the guard's model to load, and prints the key every stack must
send. Both choices are saved in `.env.sidecars`; later runs reuse them.

Pin `TAG` in `.env.sidecars` to the release the stacks run. Upgrading: `./selfhost-sidecars.sh
--upgrade` first, then each stack.

### 2. Each stack

```bash
SHARED_SIDECARS="guard classify" STACK_NAME=internal ./selfhost.sh
```

The first run creates `.env.internal` with fresh secrets and stops with a short list of what to
set before the first start:

- `SERVER_PORT` and `CLIENT_PORT` — unique on the machine (the plain install uses 3001 and 5176;
  the ports are published on `127.0.0.1` only, for the reverse proxy);
- `SERVER_PUBLIC_HOST`, `CLIENT_PUBLIC_HOST`, `SERVER_PROTOCOL`, `CLIENT_PROTOCOL` and
  `COOKIE_SECURE=true` — this stack's own hostname behind the proxy;
- `PII_SERVICE_API_KEY` and `CLASSIFY_SERVICE_API_KEY` — the `SERVICES_API_KEY` of
  `.env.sidecars`. These are not the stack's own `SERVICES_API_KEY`, which stays per stack.

Run the same command again. The stack starts as compose project `internal`: containers
`internal-server`, `internal-postgres`, …, networks `internal-network` and
`internal-browser-network`, volumes `internal-pgdata`, `internal-data`, `internal-rustfs-data`,
components directory `components.internal/`. Its server joins `internal-sidecars` and reaches the
guard as `http://guard-service:8100` and the classifier as `http://classify-service:8300` over it.
`SHARED_SIDECARS` is saved in `.env.internal`, like `PROFILES`.

Every later command takes the stack name: `STACK_NAME=internal ./selfhost.sh --upgrade`,
`--status`, `--logs`, `--stop`, `--down`, `--uninstall` (which asks you to type the stack name).

Then the same for `public`, with its own ports and hostname.

A stack that should run its own guard instead keeps `PROFILES="core guard"` and no
`SHARED_SIDECARS`; the script refuses a profile that is both shared and local.

### 3. The reverse proxy

One proxy process on the host, and it is the only thing listening on the public interface. With
Caddy, bind each site to one address: the public hostname on the public IP, the internal hostname
on the internal IP (or the WireGuard/Tailscale address). The internal name does not exist in public
DNS and gets a certificate from your internal CA or Caddy's own (`tls internal`).

```caddyfile
beeflow.example.com {
    bind 203.0.113.10
    reverse_proxy 127.0.0.1:5176
}

beeflow-intern.example.lan {
    bind 10.0.0.10
    tls internal
    reverse_proxy 127.0.0.1:5276
}
```

Host firewall: inbound on the public interface is 443 (and SSH from your management network),
nothing else. The stacks themselves publish on `127.0.0.1`, so there is nothing for the firewall to
close — which matters, because Docker publishes ports ahead of ufw/firewalld and a rule there would
not have closed one.

### 4. Check the boundary

From the internet, only the public hostname answers; a port scan of the public IP shows 443. From
inside the public server, the internal stack is unreachable while the shared guard is reachable:

```bash
docker exec public-server node -e "fetch('http://internal-server:3001/api/health').then(()=>process.exit(1),()=>process.exit(0))" && echo "internal stack unreachable: ok"
docker exec public-server node -e "fetch('http://guard-service:8100/health').then(r=>process.exit(r.ok?0:1))" && echo "guard reachable: ok"
```

## Rules that keep it that way

- **`DOCKER_SOCKET=0` in every stack.** Whoever holds the socket holds the host, and so every
  other stack. The internet-facing stack in particular must never get it.
- **Never put two servers on one network.** The sidecars join every stack's network; a stack
  joins only its own. Do not add a stack's server to another stack's network "for a quick
  integration" — route that through the reverse proxy and an API token like any other client.
- **The sidecars are the one thing on both networks.** A shared guard can therefore address both
  servers' APIs, as an anonymous client with no session and no key — that is the price of
  sharing it. Where even that is too much (one of the stacks is audited as a separate system),
  give that stack its own guard (`PROFILES="core guard"`, no `SHARED_SIDECARS`) and keep the
  shared one for the others.
- `AUTOMATION_ALLOW_PRIVATE_TARGETS` stays unset in the public stack (the default). The internal
  stack may set it when automations must reach systems on the LAN.
- Keep `TAG` equal across `.env.sidecars` and every `.env.<stack>`; upgrade sidecars first.
- Back up per stack, separately, and keep the internal stack's backups on the internal side.
- One guard for several stacks is one point of failure for all of them: the guard fails closed, so
  while it is down every stack with `SHARED_SIDECARS` blocks chat. Size it for the sum
  (`GUARD_CPUS`, `GUARD_PII_MAX_CONCURRENCY` in `.env.sidecars`) and watch its health.

## Adding or removing a stack later

Add: `SIDECAR_STACKS="public internal archive" ./selfhost-sidecars.sh` creates `archive-sidecars`
and attaches the sidecars; then `STACK_NAME=archive ./selfhost.sh` as above. Remove: `STACK_NAME=…
./selfhost.sh --down` (or `--uninstall`) first — a network with a server on it cannot be removed —
then re-run the sidecars with the shorter list.
