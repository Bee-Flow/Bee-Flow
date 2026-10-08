---
title: Learning Center videos
---

# Learning Center videos

The lessons in the Learning Center can include short videos. They are not part of the
Docker images: the server fetches them by itself and serves them from your own
installation.

## How it works

- A few seconds after startup, the server checks which video pack this Bee Flow release
  pins. The pack comes from the Bee Flow GitHub release `learn-media`.
- Every release pins its pack by version, and the pinned manifest and every file in it are
  verified with **sha256** before anything goes live. A file that does not match is
  rejected and the videos you already have stay in place.
- Only files you do not have yet are downloaded, so an upgrade that changes one video
  downloads one video.
- Your **browsers only talk to your own server**: the videos are served from
  `/learn-media/*` on your Bee Flow address. Nothing is loaded from GitHub by a user's
  browser.
- If the download fails (no internet, GitHub unreachable), lessons play without their
  video and the server retries by itself: after 1 minute, 5 minutes, 30 minutes, then
  every 6 hours.

The videos are stored in `LEARN_MEDIA_DIR` (default `/app/data/learn-media` in the
container). Keep that directory on a volume so a recreated container does not download
them again.

## Air-gapped installs

Switch the automatic download off and install a pack from a file instead:

```bash
# .env
LEARN_MEDIA_AUTO=off
```

```bash
# on a machine with internet: download the pack tarball, then on the Bee Flow host:
npm run learn-media:fetch -- /path/to/learn-media-pack.tar.gz
```

The tarball is checked against the same manifest and sha256 rules as the automatic route,
and installed atomically. Set `LEARN_MEDIA_PACK_SHA256` to also check the tarball itself.

## Using a mirror

If your servers cannot reach GitHub but can reach an internal host, copy the release
assets to a web server and point the download at it:

```bash
LEARN_MEDIA_SOURCE=https://mirror.example.com/learn-media/
```

The mirror must serve the release assets under their plain file names (the manifest and
each video, caption and poster file) over **https**. The sha256 pin still applies, so a
mirror cannot change the content.

## Settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `LEARN_MEDIA_AUTO` | on | `off`, `false` or `0` stops the server from fetching videos by itself. |
| `LEARN_MEDIA_SOURCE` | the pinned GitHub release | https base URL to fetch the release assets from instead. |
| `LEARN_MEDIA_DIR` | `server/data/learn-media` (`/app/data/learn-media` in the container) | Where the videos are stored and served from. |
