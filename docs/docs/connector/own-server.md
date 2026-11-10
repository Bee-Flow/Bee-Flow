---
title: Bee Flow on your own server next to Nextcloud
---

# Bee Flow on your own server next to Nextcloud

You can run Bee Flow yourself and connect your Nextcloud to it instead of to Bee Flow Cloud. This page
says who does what.

**The connector does not install Bee Flow.** The Nextcloud app is one small container that AppAPI
starts; it serves the Bee Flow page inside Nextcloud and passes requests on. The Bee Flow server, its
database and its storage are a separate stack that you, the administrator, install and look after.
In Nextcloud you then tell the connector where that server is.

## The steps

1. **Install Bee Flow with the self-host script** on a host of your own:
   [Docker Compose → Easy install](../self-hosting/docker-compose.md#easy-install). The script
   generates the secrets, starts the stack and prints the address and the administrator password.

2. **Put it behind your own reverse proxy with HTTPS**, on a hostname of its own (for example
   `https://beeflow.example.com`): [Reverse proxy + TLS](../self-hosting/docker-compose.md#reverse-proxy--tls).
   This address is the one you enter in Nextcloud.

3. **Sign in to Bee Flow** at that address, change the administrator password and add a model
   provider.

4. **Generate a pairing code** in Bee Flow: **Settings → Organisation → Pair a new Nextcloud**. A
   self-hosted server does not create an organisation for a Nextcloud it does not know; the pairing
   code is how you link the two. This is the default for every self-hosted server.

5. **In Nextcloud**, install the connector ([Install on Nextcloud](../getting-started/nextcloud.md)),
   open **Bee Flow** from the top bar as a Nextcloud administrator, choose **Self-hosted server**,
   and enter the address of step 2 and the pairing code of step 4. Press **Connect**. The connector
   first asks your server for `/api/health`; when no Bee Flow server answers there, nothing is saved
   and nothing is sent. More in [Choose where Bee Flow runs](setup-picker.md).

6. **Finish the onboarding wizard.** Still as a Nextcloud administrator, open **Bee Flow** again:
   the web app shows the wizard of your organisation. Until it is finished, the server holds other
   users back (`403`, code `NC_ONBOARDING_PENDING`); afterwards they get the app.

## What the host needs

- **Docker with the Compose plugin**, and a shell to run the script.
- **Room next to what Nextcloud uses.** The minimum for Bee Flow is 2 CPU cores, 4 GB of memory and
  10 GB of disk; see [Minimum and recommended hardware](../self-hosting/index.md#minimum-and-recommended-hardware)
  and [Memory sizing](../self-hosting/docker-compose.md#memory-sizing). On a host that already runs
  Nextcloud this comes on top.
- **An amd64 (x86-64) machine.** The Bee Flow server images are published for `linux/amd64` only
  ([Docker Hub](../self-hosting/docker-hub.md)). The connector image itself also runs on arm64.
- **A reverse proxy with a certificate** for the Bee Flow hostname. A certificate from a public
  certificate authority works as it is; for one from your own authority, give the connector that
  authority at install time (`BEEFLOW_SERVER_CA_CERT`, see
  [Architecture → Connector environment variables](architecture.md#connector-environment-variables)).
  Certificate verification cannot be switched off.
- **Nextcloud served over HTTPS**, so that signing in to Bee Flow inside Nextcloud works.
- **A network path in both directions.** The connector container must reach the Bee Flow address,
  and the Bee Flow server must reach your Nextcloud. For a Nextcloud that has only a private
  address, see [Nextcloud is not reachable from the internet](troubleshooting.md#not-reachable).

Enter the HTTPS address of your reverse proxy in Nextcloud, not `localhost`: inside the connector
container `localhost` is the container itself.

## What stays yours

- **Backups.** The Bee Flow stack has its own database, files and `.env` (which holds the keys your
  data is sealed with). The backup of your Nextcloud does not include them. See
  [Backups](../self-hosting/docker-compose.md#backups).
- **Updates.** The connector is updated through Nextcloud's Apps page; the Bee Flow stack is not.
  You update it yourself: [Upgrades](../self-hosting/upgrades.md).
- **Security of the host**: the reverse proxy, the firewall and who may sign in. See the
  [production hardening checklist](../self-hosting/docker-compose.md#production-hardening-checklist).

## Where this does not work

- **Hosting without Docker or without a shell**, such as managed or shared Nextcloud hosting. There
  is no place to run the Bee Flow stack, and the connector cannot be installed there either. Run
  Bee Flow on another machine, or use Bee Flow Cloud, and see
  [No Docker on your Nextcloud host?](../integrations/nextcloud.md#no-docker)
- **Small ARM boards.** The server images are amd64 only, and the hardware minimum above applies.
- **A Nextcloud that Bee Flow Cloud cannot reach** is a reason to run your own server, not an
  obstacle to it: see [Nextcloud is not reachable from the internet](troubleshooting.md#not-reachable).
