# Omen Backend — Off-chain Infrastructure

Supporting infrastructure for Omen Protocol: event indexing, slash monitoring, Walrus blob registry, and an AI audit oracle.

This is not required to run the live demo — the frontend and SDK read directly from Sui RPC. This repo is the production-grade infrastructure layer planned for scale.

## What's here

| Folder | Purpose |
|---|---|
| `sources/indexer/` | Listens for on-chain Omen events, indexes them to Postgres |
| `sources/monitoring/` | Watches for slash events in real time |
| `audit/walrus/` | Publishes and fetches audit blobs on Walrus |
| `audit/oracle/` | AI-assisted audit agent for reviewing protocol applications |
| `audit/mcp/` | Model Context Protocol server for agent tooling |

## Why it exists separately from the SDK

The SDK and frontend are read-only and need no backend — they query Sui RPC directly, by design, so the live demo has no single point of failure. This repo is the heavier infrastructure that becomes necessary at scale: real-time event indexing, automated audit workflows, and Walrus blob lifecycle management.

## Status

Built and functional in isolated pieces during development. Not currently deployed — see [roadmap](https://github.com/omenprotocol/omen-landing-page) for activation timeline alongside mainnet launch.

## Run locally

```bash
npm install
cp .env.example .env   # fill in your own RPC and DB credentials
npm run dev
```

## Live demo

[omenprotocol.github.io/omen-landing-page](https://github.com/omenprotocol/omen-landing-page)

## License

MIT
