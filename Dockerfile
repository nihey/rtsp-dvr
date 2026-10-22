FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# Install ffmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY index.js ./

# Create recordings directory
RUN mkdir -p /app/recordings

# Set default environment variables
ENV NODE_ENV=production
ENV SEGMENT_SECONDS=3600
ENV RETENTION_DAYS=90

# Default output directory
VOLUME ["/app/recordings"]

# Health check - verify ffmpeg is available
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ffmpeg -version || exit 1

# Run the application
CMD ["node", "index.js", "url"]

