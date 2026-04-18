FROM node:20-bookworm-slim AS deps
WORKDIR /workspace/api-gateway/src
COPY api-gateway/src/package.json api-gateway/src/package-lock.json* ./
COPY shared-sdk-client/typescript /workspace/shared-sdk-client/typescript
COPY contracts-and-schemas /workspace/contracts-and-schemas
RUN npm install -g npm@11.12.1 \
	&& npm --prefix /workspace/shared-sdk-client/typescript install \
	&& npm --prefix /workspace/shared-sdk-client/typescript run build \
	&& npm install

FROM node:20-bookworm-slim AS build
WORKDIR /workspace/api-gateway/src
COPY --from=deps /workspace/api-gateway/src/node_modules ./node_modules
COPY --from=deps /workspace/shared-sdk-client/typescript /workspace/shared-sdk-client/typescript
COPY api-gateway/src .
RUN npm install -g npm@11.12.1 && npm install && npm run build
RUN npm prune --production

FROM node:20-bookworm-slim AS runtime
WORKDIR /workspace/api-gateway/src
ENV NODE_ENV=production
COPY --from=build /workspace/api-gateway/src/node_modules ./node_modules
COPY --from=build /workspace/shared-sdk-client/typescript /workspace/shared-sdk-client/typescript
COPY --from=build /workspace/api-gateway/src/dist ./dist
COPY --from=build /workspace/api-gateway/src/.env.example ./.env.example
RUN chown -R node:node /workspace
USER node
EXPOSE 7005
CMD ["node", "dist/app/server.js"]
