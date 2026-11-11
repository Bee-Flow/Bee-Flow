---
title: Bee Flow on your own server next to Nextcloud
---

# Bee Flow on your own server next to Nextcloud

You can run Bee Flow yourself and connect your Nextcloud to it instead of to Bee Flow Cloud. This page
says who does what.

**The connector does not install Bee Flow.** The Nextcloud app is one small container that AppAPI
starts; it serves the Bee Flow page inside Nextcloud and passes requests on, and it has no access to
Docker. The Bee Flow server, its database and its storage are a separate stack that you, the
administrator, install and look after. In Nextcloud you then tell the connector where that server is.

## The quick way: the installer {#install-script}

The installer is for a Bee Flow on your own network, reached over plain `http` on two ports of the
Docker host. For a server on the internet, follow [The steps](#the-steps) below and put a reverse
proxy with HTTPS in front. It is published with every Bee Flow release, the same for everybody, in
two forms that ask the same questions and do the same work.

**As a container.** On the Docker host, as a user who may use Docker:

```bash
docker run --rm -it --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/beeflow:/opt/beeflow \
  ghcr.io/bee-flow/installer
```

Bee Flow is installed in `/opt/beeflow`. For another directory, name it three times with the same
path: `-v /srv/bee:/srv/bee … ghcr.io/bee-flow/installer --dir /srv/bee`. The image carries the
files of its release, so nothing is downloaded but the Bee Flow images themselves. It needs the
Docker socket because it starts the containers through the Docker of the host, and the host network
to see which ports are free and to wait for the server. It opens no port and is gone when it is
done. The files it writes belong to root.

**As a script,** when you prefer not to hand the Docker socket to a container:

```bash
curl -fsSLO https://github.com/Bee-Flow/Bee-Flow/releases/latest/download/beeflow-install.sh
curl -fsSLO https://github.com/Bee-Flow/Bee-Flow/releases/latest/download/beeflow-install.sh.sha256
sha256sum -c beeflow-install.sh.sha256
bash beeflow-install.sh
```

The script downloads the release's `selfhost.sh`, compose file and settings template from the
release and checks them against the release's `SHA256SUMS` before it uses them.

Both ask their questions in the terminal; Enter accepts each default:

| Question | What it is for |
|---|---|
| Address of this Docker host | The name or IP address at which Nextcloud reaches the machine. Not `localhost`. |
| Server port, web app port | Where the server (default 3001) and the web app (default 5176) are published. |
| Install directory | Where the release's files and the settings file live. The script asks (default `beeflow`); the container uses `/opt/beeflow`. |
| Version | The script takes the newest production release unless you name one. The container installs the release it was built for. |
| PII guard and topic classifier | On by default. They need about 7 GB of memory and a larger first download. |
| Is the Nextcloud on a private address | On by default. Lets the server call private addresses (`NEXTCLOUD_ALLOW_PRIVATE_HOSTS`). Answer no for a Nextcloud on the internet. |
| Name of your organisation | The installer creates it and prints a pairing code for your Nextcloud. |

Before it starts anything the installer checks that this machine can run Bee Flow (Docker, an
x86-64 processor, free ports, memory and disk) and stops with what to do when it cannot. When it
finishes, the terminal shows the address of the server and of the web app, the administrator
password, a pairing code (valid for 15 minutes) and the secrets the install generated. **Every
secret is generated on your host.** In Nextcloud, open **Bee Flow** as an administrator: with the
default server port the setup page finds the server on the same machine and offers its address.
Choose **Self-hosted server**, check the two addresses, enter the pairing code and press **Connect**.

A new pairing code later, for another Nextcloud or when the first one ran out: the same command
ending in `pairing-code`. It signs in with the administrator password of the install; once that
password is changed or a second factor is on, make the code in Bee Flow itself (**Settings →
Organisation → Pair a new Nextcloud**).

**Why the commands are fixed text.** The setup page in Nextcloud shows these same commands under
**No Bee Flow server yet?**, and nothing more: it does not make a script from what you type there. A
command you run on your server should come from the release, where you can read and check it, not
from a web page that fills things in. Compare the commands on the page with the ones here whenever
you want to be sure.

Without questions, for a script of your own: every answer is an option or a variable, for example
`BEEFLOW_HOST=192.168.1.20 BEEFLOW_ORGANISATION="Acme" bash beeflow-install.sh --yes` (with the
container: `-e BEEFLOW_HOST=…` and `--yes` after the image name). `--help` lists every option.

Keep the settings file (`.env` in the install directory) and a copy of the secrets the installer
prints: without `MASTER_ENCRYPTION_KEY` the stored data cannot be read again.

## Updating Bee Flow {#update}

Make a backup first ([Upgrades](../self-hosting/upgrades.md) says what to save). Then, on the Docker
host:

```bash
docker pull ghcr.io/bee-flow/installer
docker run --rm -it --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/beeflow:/opt/beeflow \
  ghcr.io/bee-flow/installer update
```

or, with the script, fetch the newest one as above and run `bash beeflow-install.sh update`.

It shows the version you run and the release it goes to, refuses to go back to an older one, asks
before it changes anything, sets the new version in the settings file and runs
`./selfhost.sh --upgrade`. When the update fails before the server changed, it puts the previous
version back by itself; otherwise it prints how to go back. The connector in Nextcloud needs
nothing: it keeps its connection, and Nextcloud updates the connector itself through its Apps page.

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
