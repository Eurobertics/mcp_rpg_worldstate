import { createServer as httpServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerAuth } from "./auth.js";
import { createServer } from "./server.js";
import type { WorldStateStore } from "./store.js";
import type { NetworkConfig } from "./config.js";
export function createNetworkServer(config: NetworkConfig, store: WorldStateStore): Server {
  const authorized = bearerAuth(config.token);
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.split("?")[0] !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req.headers.authorization)) {
      res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="rpg-worldstate"' }).end();
      return;
    }
    // Native MCP clients only; reject cross-origin browser requests.
    if (req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    // Requests share persistent data, never protocol session state.
    const server = createServer(store);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true
    });
    const cleanup = () => { void server.close().catch(() => {}); };
    res.once("close", cleanup);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
      cleanup();
    }
  };
  const listener = (req: IncomingMessage, res: ServerResponse) => { void handler(req, res); };
  return config.transport === "https"
    ? httpsServer({
        cert: readFileSync(config.cert!), key: readFileSync(config.key!), minVersion: "TLSv1.2"
      }, listener)
    : httpServer(listener);
}
