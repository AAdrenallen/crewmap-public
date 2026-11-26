import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { MemoryStore, RelayCore, type EventStore } from './core.ts';
import { SqliteStore } from './sqliteStore.ts';

/**
 * CrewMap optional central-PC relay: a blind Nostr relay for CrewMap event kinds only. Holds no circle keys and
 * sees only ciphertext. Expose it through Tailscale Funnel or a Cloudflare Tunnel, never an open router port.
 *
 *   PORT=7447 DB=/data/relay.db node --experimental-strip-types src/server.ts
 */
const PORT = Number(process.env.PORT ?? 7447);
const DB = process.env.DB ?? '';
const KINDS = [21420, 1420];
const MAX_TTL_S = 31 * 86_400;

const store: EventStore = DB ? new SqliteStore(DB) : new MemoryStore();
const core = new RelayCore(store, { allowedKinds: KINDS, maxTtlS: MAX_TTL_S });

const http = createServer((req, res) => {
  if (req.headers.accept === 'application/nostr+json') {
    res.writeHead(200, { 'content-type': 'application/nostr+json', 'access-control-allow-origin': '*' });
    res.end(
      JSON.stringify({
        name: 'CrewMap relay',
        description: 'Blind store-and-forward relay for one CrewMap circle',
        supported_nips: [1, 11, 40],
        software: 'crewmap-relay',
        limitation: { max_message_length: 65536, restricted_writes: true },
      }),
    );
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, events: store.count(), ...core.stats }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http, maxPayload: 128 * 1024 });
wss.on('connection', (ws) => {
  const conn = randomUUID();
  core.connect(conn, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)));
  ws.on('message', (data) => {
    try {
      core.handle(conn, JSON.parse(data.toString()));
    } catch {
      ws.send(JSON.stringify(['NOTICE', 'invalid JSON']));
    }
  });
  ws.on('close', () => core.disconnect(conn));
});

setInterval(() => core.purge(), 60_000).unref();
http.listen(PORT, () => {
  process.stdout.write(`crewmap relay listening on :${PORT} (${DB ? `sqlite ${DB}` : 'memory'})\n`);
});
