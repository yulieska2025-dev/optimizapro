# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy frontend code
COPY client ./client
COPY shared ./shared
COPY vite.config.ts tsconfig.json tailwind.config.ts postcss.config.js ./

# Build frontend
RUN npm run build

# Stage 2: Build backend & run application
FROM node:20-alpine

WORKDIR /app

# Install dependencies required for system packages
RUN apk add --no-cache python3 make g++ cairo-dev jpeg-dev pango-dev giflib-dev

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy server code
COPY server ./server
COPY shared ./shared
COPY script ./script
COPY drizzle.config.ts tsconfig.json ./

# Copy built frontend from stage 1
COPY --from=frontend-builder /app/dist ./dist

# Expose the port
EXPOSE 5000

# Default to port 5000 if PORT env var is not set
ENV PORT=5000
ENV NODE_ENV=production

# Start the application
CMD ["node", "dist/index.cjs"]
