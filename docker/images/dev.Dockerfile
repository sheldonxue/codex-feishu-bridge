ARG NODE_IMAGE=node:20-bookworm
FROM ${NODE_IMAGE}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        curl \
        git \
        python3 \
        python3-pip \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/codex-feishu-bridge

ENTRYPOINT ["tini", "--"]
CMD ["bash"]
