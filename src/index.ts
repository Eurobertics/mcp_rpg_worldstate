#!/usr/bin/env node
import { once } from "node:events";
import { readConfig } from "./config.js";
import { createNetworkServer } from "./http.js";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { WorldStateStore } from "./store.js";

const config = readConfig();
const databasePath = resolve(config.database);
const store = new WorldStateStore(databasePath);
try {
  let close: () => Promise<void>;
  if (config.transport === "stdio") {
    const server = createServer(store);
    await server.connect(new StdioServerTransport());
    close = () => server.close();
  } else {
    const listener = createNetworkServer(config, store);
    listener.listen(config.port, config.host);
    await once(listener, "listening");
    console.error(`MCP endpoint: ${config.transport}://${config.host}:${config.port}/mcp`);
    close = () => new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
      listener.closeIdleConnections();
    });
  }
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void close().catch(() => { process.exitCode = 1; }).finally(() => store.close());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.error(`mcp-rpg-worldstate is using ${databasePath}`);
} catch (error) {
  store.close();
  throw error;
}
