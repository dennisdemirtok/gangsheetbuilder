FROM node:22-slim

# Sharp + Prisma deps for Debian
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
WORKDIR /app

# Install ALL deps (including devDependencies for build step)
COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force

COPY . .

# Generate Prisma client and build
RUN npx prisma generate
RUN npm run build

# Remove devDependencies after build
RUN npm prune --omit=dev
RUN npm remove @shopify/cli 2>/dev/null || true

ENV NODE_ENV=production

CMD ["npm", "run", "docker-start"]
