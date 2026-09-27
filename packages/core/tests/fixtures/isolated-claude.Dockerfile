FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS agent
RUN npm install --global @anthropic-ai/claude-code@2.1.283 && npm cache clean --force
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["node"]

# Trusted test supervisor only. Never use this target as the executable agent.
FROM agent AS broker-test-parent
USER root
RUN apk add --no-cache docker-cli
