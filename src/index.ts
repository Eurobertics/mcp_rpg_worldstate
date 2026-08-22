#!/usr/bin/env node
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { WorldStateStore } from "./store.js";

const databasePath = resolve(process.env.RPG_WORLDSTATE_DB ?? "rpg-worldstate.sqlite");
const store = new WorldStateStore(databasePath);
const server = createServer(store);
const transport = new StdioServerTransport();

const shutdown = async () => {
  await server.close();
  store.close();
};

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

await server.connect(transport);
console.error(`mcp-rpg-worldstate is using ${databasePath}`);
