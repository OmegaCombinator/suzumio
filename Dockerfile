FROM node:24-bookworm

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
RUN mkdir -p /turn /workspace
ENTRYPOINT ["node", "/app/dist/runner.js"]
