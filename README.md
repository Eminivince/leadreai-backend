# LeadreAI — Backend

Express + BullMQ backend for LeadreAI. API and workers in one repo, deployed as two services pointing at the same Mongo + Redis.

## Stack

- **Node.js 20**, ESM (`"type": "module"`)
- **Express 4** API layer
- **BullMQ + ioredis** for background jobs and rate limiting
- **Mongoose** + MongoDB
- **TypeScript 5**, strict
- **Resend / Stripe / Anthropic / OpenAI** integrations
- **Sentry** for error tracking

## Project structure

```
leadreai-backend/
├── src/         Express API (auth, routes, controllers, services, SSE)
├── workers/     BullMQ workers (prospecting, outreach, contact enrichment, …)
├── shared/      Inlined types & zod schemas (was @leadreai/shared)
├── scripts/     One-off dev/maintenance scripts (tsx-run, not built)
└── sandbox/     Docker sandbox for untrusted code execution
```

## Local development

```bash
pnpm install
cp .env.example .env       # if .env.example exists
pnpm dev                   # API on :4000
pnpm dev:workers           # in a second terminal, run the workers
```

Requires local Mongo and Redis, or env vars pointing at remote instances.

## Production scripts

```bash
pnpm build           # tsc → dist/
pnpm start:api       # node dist/src/index.js
pnpm start:workers   # node dist/workers/index.js
```

## Environment

See `src/config/env.ts` for the full list of required variables. At minimum:

```
NODE_ENV=production
PORT=4000
MONGODB_URI=...
REDIS_URL=...
JWT_SECRET=...
JWT_REFRESH_SECRET=...
FRONTEND_URL=...
```

## Deployment

Two services on Railway or Render, both reading from this repo:

| Service | Start command | Why |
|---|---|---|
| `api` | `pnpm start:api` | Express server, BullMQ producer, SSE |
| `workers` | `pnpm start:workers` | BullMQ consumers, long-running |

Both share the same Mongo + Redis connection strings.
