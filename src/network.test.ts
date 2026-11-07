import assert from 'node:assert/strict';
import { it } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readConfig } from './config.js';
import { bearerAuth } from './auth.js';
import { createNetworkServer } from './http.js';
import { WorldStateStore } from './store.js';

it('defaults to stdio and rejects invalid network configuration', () => {
  assert.equal(readConfig({}).transport, 'stdio');
  for (const env of [
    { RPG_WORLDSTATE_TRANSPORT: 'bad' },
    { RPG_WORLDSTATE_TRANSPORT: 'http' },
    { RPG_WORLDSTATE_TRANSPORT: 'https', RPG_WORLDSTATE_TOKEN: 'secret' },
    { RPG_WORLDSTATE_TRANSPORT: 'http', RPG_WORLDSTATE_TOKEN: 'secret', RPG_WORLDSTATE_PORT: '1.5' }
  ]) assert.throws(() => readConfig(env));
  assert.equal(readConfig({ RPG_WORLDSTATE_TRANSPORT: 'http', RPG_WORLDSTATE_TOKEN: 'secret' }).transport, 'http');
});

it('accepts only the configured bearer token', () => {
  const auth = bearerAuth('secret');
  for (const value of [undefined, '', 'Basic secret', 'Bearer wrong', 'Bearer secret extra'])
    assert.equal(auth(value), false);
  assert.equal(auth('Bearer secret'), true);
  assert.equal(auth('bearer secret'), true);
});

it('authenticates HTTP and serves independent MCP clients sharing world state', async () => {
  const store = new WorldStateStore();
  const server = createNetworkServer({ transport: 'http', host: '127.0.0.1', port: 3000, token: 'secret' }, store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = new URL('http://127.0.0.1:' + address.port + '/mcp');
  const clients: Client[] = [];
  try {
    for (const authorization of ['', 'Bearer wrong']) {
      const response = await fetch(url, { method: 'POST', headers: { authorization } });
      assert.equal(response.status, 401);
      assert.match(response.headers.get('www-authenticate')!, /Bearer/);
    }
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer secret' } })).status, 405);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer secret', origin: 'https://example.com' } })).status, 403);
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: 'test', version: '1' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer secret' } } }));
      assert.equal((await client.listTools()).tools.length, 13);
    }
    await clients[0]!.callTool({ name: 'create_world', arguments: { name: 'Shared world' } });
    assert.match(JSON.stringify(await clients[1]!.callTool({ name: 'list_worlds', arguments: {} })), /Shared world/);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

it('serves MCP over TLS using a supplied certificate and key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worldstate-tls-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const store = new WorldStateStore();
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    const server = createNetworkServer({ transport: 'https', host: '127.0.0.1', port: 3000, token: 'secret', cert, key }, store);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const result = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: address.port, path: '/mcp', method: 'POST', ca: readFileSync(cert), headers: { authorization: 'Bearer secret', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tls-test', version: '1' } } }));
      });
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.body).result.serverInfo.name, 'mcp-rpg-worldstate');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    assert.throws(() => createNetworkServer({ transport: 'https', host: 'localhost', port: 3000, token: 'secret', cert: join(dir, 'missing'), key }, store));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
