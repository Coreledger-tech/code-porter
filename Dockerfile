FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json vitest.config.ts vitest.integration.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY policies ./policies
COPY fixtures ./fixtures
COPY docs ./docs
COPY AGENTS.md ./AGENTS.md

RUN npm ci

EXPOSE 3000

CMD ["npm", "run", "api:start"]
