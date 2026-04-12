FROM node:22-alpine

# Sharp dependencies for Alpine
RUN apk add --no-cache openssl vips-dev fftw-dev build-base python3 pkgconfig

EXPOSE 3000
WORKDIR /app

# Install deps with dev (needed for build), then prune
COPY package.json package-lock.json* ./

# Install ALL deps (including devDependencies for build step)
RUN npm ci && npm cache clean --force

COPY . .

# Generate Prisma client and build the app
RUN npx prisma generate
RUN npm run build

# Remove devDependencies after build
RUN npm prune --omit=dev
# Remove CLI packages not needed in production
RUN npm remove @shopify/cli 2>/dev/null || true

ENV NODE_ENV=production

CMD ["npm", "run", "docker-start"]
