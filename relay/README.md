# CrewMap relay (optional central-PC fallback)

Only needed if `docs/P2P-BENCHMARK.md` moves a function off P2P. It is a blind Nostr relay (NIP-01/11/40) that accepts
only CrewMap event kinds and expiring events, plus a self-hosted ntfy for wake-ups. It never sees keys or plaintext.

## Start (one command)
```
docker compose -f relay/docker-compose.yml up -d
```
Without Docker: `pnpm relay` (in-memory) or `DB=relay.db pnpm relay` (persistent, Node's built-in SQLite).

## Expose it (no router ports)
- Tailscale Funnel: `tailscale funnel --bg 7447` → `wss://<pc>.<tailnet>.ts.net`
- or Cloudflare Tunnel: `cloudflared tunnel --url http://localhost:7447`

Put the URL in the app: Settings → Developer → Transport → PC relay URL, then switch functions to "PC".
Health: `curl http://localhost:7447/health`.
