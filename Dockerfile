# Compile server + IDE. Builds with arduino-cli inside the container.
FROM node:22-bookworm-slim

ARG ARDUINO_CLI_VERSION=1.5.1
# Space-separated list of cores to preinstall
ARG CORES="arduino:avr esp32:esp32"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
    | BINDIR=/usr/local/bin sh -s ${ARDUINO_CLI_VERSION}

# Never compile user code as root
USER node
ENV HOME=/home/node
WORKDIR /home/node

RUN arduino-cli config init \
 && arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json \
 && arduino-cli core update-index \
 && arduino-cli core install ${CORES} \
 && arduino-cli lib update-index

# Warm the core build cache so the first user compile is fast
RUN mkdir -p /tmp/warm/Blink \
 && printf 'void setup(){}\nvoid loop(){}\n' > /tmp/warm/Blink/Blink.ino \
 && for f in arduino:avr:uno arduino:avr:nano arduino:avr:mega esp32:esp32:esp32; do \
      arduino-cli compile --fqbn $f /tmp/warm/Blink >/dev/null 2>&1 || true; done \
 && rm -rf /tmp/warm

WORKDIR /home/node/app
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .

ENV NODE_ENV=production PORT=10000 COMPILE_JOBS=2
EXPOSE 10000
CMD ["node", "server.js"]
