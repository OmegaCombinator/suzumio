FROM node:24-bookworm

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 curl git && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY webui ./webui
RUN npm run build

ENV NODE_ENV=production
RUN mkdir -p /activation /workspace
ENTRYPOINT ["node", "/app/dist/runner.js"]
