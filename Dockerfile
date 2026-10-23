# Container für Discord 2.0. Wird von .github/workflows/deploy.yml gebaut.
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_FILE=/data/discord2.db

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

# Daten (SQLite) liegen in /data – dort ein Volume einhängen.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:' + process.env.PORT + '/api/config').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
