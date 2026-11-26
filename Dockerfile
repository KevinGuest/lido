############################
# Docker build environment #
############################

FROM node:24.22.3-bookworm-slim AS build

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

# Build Lido pool (glob deprecation warn from transitive deps is harmless).
# sqlite3 6 publishes a prebuild linked against glibc 2.38. Bookworm is 2.36,
# so compile the addon here and refuse the image if that binary will not load.
RUN npm ci --no-audit --no-fund \
    && npm rebuild sqlite3 --build-from-source \
    && node -e "const s=require('sqlite3'); const db=new s.Database(':memory:'); db.close();" \
    && npm run build

############################
# Docker final environment #
############################

FROM node:24.22.3-bookworm-slim

# Expose ports for Stratum and Bitcoin RPC
EXPOSE 3333 3334 8332

WORKDIR /public-pool

# Copy built binaries into the final image
COPY --from=build /build .
#COPY .env.example .env

CMD ["/usr/local/bin/node", "dist/main"]
