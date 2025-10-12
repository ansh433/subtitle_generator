#api server docker files
# Build Stage
# Install all dependencies and compile the TypeScript
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Production Stage 
# This stage creates the final lean image
FROM node:18-alpine
WORKDIR /app
# Copy package files to install  production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the compiled code from the 'builder' stage
COPY --from=builder /app/dist ./dist

# Expose the port and run the compiled app
EXPOSE 3000
CMD ["node", "dist/index.js"]