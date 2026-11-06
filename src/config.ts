export type NetworkConfig = {
  transport: "http" | "https"; host: string; port: number; token: string;
  cert?: string; key?: string;
};
export function readConfig(env: NodeJS.ProcessEnv = process.env):
  ({ transport: "stdio" } | NetworkConfig) & { database: string } {
  const transport = env.RPG_WORLDSTATE_TRANSPORT ?? "stdio";
  const database = env.RPG_WORLDSTATE_DB ?? "rpg-worldstate.sqlite";
  if (transport === "stdio") return { transport, database };
  if (transport !== "http" && transport !== "https")
    throw new Error("RPG_WORLDSTATE_TRANSPORT must be stdio, http or https.");
  const rawPort = env.RPG_WORLDSTATE_PORT ?? "3000";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535)
    throw new Error("RPG_WORLDSTATE_PORT must be an integer from 1 to 65535.");
  const host = env.RPG_WORLDSTATE_HOST ?? "127.0.0.1";
  if (!host.trim()) throw new Error("RPG_WORLDSTATE_HOST must not be empty.");
  const token = env.RPG_WORLDSTATE_TOKEN;
  if (!token || !/^[A-Za-z0-9._~+/-]+=*$/.test(token))
    throw new Error("RPG_WORLDSTATE_TOKEN must be a non-empty Bearer token without whitespace.");
  const cert = env.RPG_WORLDSTATE_TLS_CERT;
  const key = env.RPG_WORLDSTATE_TLS_KEY;
  if (transport === "https" && (!cert || !key))
    throw new Error("HTTPS requires RPG_WORLDSTATE_TLS_CERT and RPG_WORLDSTATE_TLS_KEY.");
  return { transport, database, host, port, token, cert, key };
}
