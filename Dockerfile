############################
# Docker build environment #
############################

FROM node:24.16.0-bookworm-slim AS build

# Upgrade all packages and install dependencies
RUN apt-get update \
    && apt-get upgrade -y
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
        cmake \
        curl \
        ca-certificates \
    && apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /build

COPY . .

# Build Lido pool (glob deprecation warn from transitive deps is harmless)
RUN npm ci --no-audit --no-fund && npm run build

############################
# Docker final environment #
############################

FROM node:24.16.0-bookworm-slim

# Expose ports for Stratum and Bitcoin RPC
EXPOSE 3333 3334 8332

WORKDIR /public-pool

# Copy built binaries into the final image
COPY --from=build /build .
#COPY .env.example .env

CMD ["/usr/local/bin/node", "dist/main"]
