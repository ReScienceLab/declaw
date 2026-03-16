FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.mjs ./

RUN mkdir -p /data

ENV PEER_PORT=8099
ENV HTTP_PORT=8100
ENV DATA_DIR=/data
ENV DISCOVERY_INTERVAL_MS=60000

EXPOSE 8099 8100

CMD ["node", "server.mjs"]
