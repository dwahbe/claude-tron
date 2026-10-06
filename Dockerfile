# The lobby server. It has no dependencies, so bun and two source files are the whole image.
FROM oven/bun:1-alpine
WORKDIR /app
COPY server ./server
COPY plugins/lightcycles/hooks/protocol.ts ./plugins/lightcycles/hooks/protocol.ts
USER bun
CMD ["bun", "server/server.ts", "--host", "0.0.0.0", "--bots", "4"]
