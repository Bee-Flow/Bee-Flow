# The Bee Flow installer as a container: the terminal wizard of
# beeflow-install.sh together with the files of one release (selfhost.sh, the
# compose file, the settings example). Nothing is downloaded when it runs.
#
# Build context: this directory, with the four release files staged in
# ./bundle (release-latest.yml does that; by hand: scripts/stage-installer-context.sh).
#
#   docker run --rm -it --network host \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v /opt/beeflow:/opt/beeflow \
#     ghcr.io/bee-flow/installer
#
# The Docker CLI and the compose plugin come with the base image; it starts the
# stack through the host's Docker, which is why the socket is mounted.
FROM docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d

RUN apk add --no-cache bash coreutils curl grep openssl sed

ARG BEEFLOW_VERSION
RUN test -n "$BEEFLOW_VERSION"
ENV BEEFLOW_BUNDLE_DIR=/bundle \
    BEEFLOW_BUNDLE_VERSION=$BEEFLOW_VERSION \
    BEEFLOW_DIR=/opt/beeflow

COPY bundle/ /bundle/
COPY entrypoint.sh /usr/local/bin/beeflow-installer
RUN chmod 0555 /usr/local/bin/beeflow-installer /bundle/beeflow-install.sh /bundle/selfhost.sh

ENTRYPOINT ["/usr/local/bin/beeflow-installer"]
