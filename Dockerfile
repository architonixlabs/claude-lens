# ClaudeLens — read-only live map & timeline debugger for Claude Code runs.
#
# Note: in a container ClaudeLens cannot read Claude Code hooks directly (hooks
# run on the host). Use it as a shared viewer that host machines POST to:
#   docker run -p 4317:4317 -e AGENTVIZ_TOKEN=... -v claudelens-data:/data claude-lens
# then point the hook bridge at it:
#   AGENTVIZ_URL=http://<host>:4317/ingest  AGENTVIZ_TOKEN=...  (see hooks/)
#
# Exposing it beyond localhost means session data (prompts, paths, commands)
# leaves your machine — always set AGENTVIZ_TOKEN when you do.

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install deps first so the layer caches across source edits.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server/ ./server/
COPY public/ ./public/
COPY sim/ ./sim/

# Persist history on a volume rather than the container's writable layer.
ENV AGENTVIZ_DATA=/data
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

# Bind all interfaces *inside* the container; publish deliberately with -p.
ENV AGENTVIZ_HOST=0.0.0.0
ENV PORT=4317
EXPOSE 4317

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
