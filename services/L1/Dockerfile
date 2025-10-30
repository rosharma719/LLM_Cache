# --- deps ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# --- build ---
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY . .
RUN npm run build

# --- runtime ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# copy runtime bits
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package*.json ./

# expose Fastify
EXPOSE 8080

# container will get REDIS_URL, PORT, HOST from compose/.env
CMD ["npm", "run", "start"]
