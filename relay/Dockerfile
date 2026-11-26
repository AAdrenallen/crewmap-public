FROM node:24-alpine
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund ws@8.18.3 nostr-tools@2.26.1
COPY src ./src
ENV PORT=7447 DB=/data/relay.db NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 7447
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:7447/health || exit 1
CMD ["node", "--experimental-strip-types", "src/server.ts"]
