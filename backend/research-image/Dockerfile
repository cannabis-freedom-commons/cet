# Build, push to your registry, and configure RESEARCH_IMAGE with the resulting digest.
FROM debian:trixie-slim AS download
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) asset=opencode-linux-x64-baseline; checksum=89a6cee227b54bc011179c528a5e63176032462b1a5e21723b616801cddc2ca7 ;; \
      arm64) asset=opencode-linux-arm64; checksum=c1682057f0815cb2abdd6e00305f1146ebaf1c167f0335cdb74ddc80008120e7 ;; \
      *) echo "Unsupported research image architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v2.2.7/$asset.tar.gz" -o /tmp/opencode.tar.gz; \
    echo "$checksum  /tmp/opencode.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates
COPY --from=download /usr/local/bin/opencode /usr/local/bin/opencode
COPY tracker-research /usr/local/bin/tracker-research
RUN chmod 0555 /usr/local/bin/tracker-research && mkdir /work \
    && /usr/local/bin/tracker-research --version
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/tracker-research"]
