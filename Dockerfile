FROM node:22-alpine
RUN apk add --no-cache openssl vips-dev build-base python3

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force
RUN npm remove @shopify/cli 2>/dev/null || true

COPY . .

RUN npx prisma generate
RUN npm run build

CMD ["npm", "run", "docker-start"]
