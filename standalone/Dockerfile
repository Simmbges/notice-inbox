FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node lib/notice-input.ts lib/notice-store.ts ./lib/
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node public ./public
COPY --chown=node:node app/panel.html ./app/panel.html
COPY --chown=node:node standalone ./standalone
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data NODE_ENV=production
EXPOSE 3000
CMD ["node", "standalone/server.mjs"]
