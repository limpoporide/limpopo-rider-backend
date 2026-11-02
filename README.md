# limpopo-rider-backend

Supabase backend (NestJS API + Postgres) for the Limpopo app. Remote project ref: `hzvmtghpjaibmyvjhhzy`.

## Setup

Requires Docker (local Postgres) and Node.

```bash
npm install
npx supabase login
npx supabase link --project-ref hzvmtghpjaibmyvjhhzy
cp .env.example .env
```

## Postgres

Supabase runs Postgres. Locally it is started in Docker with `npm run supabase:start` (DB at `postgresql://postgres:postgres@127.0.0.1:54322/postgres`).

| Task | Command |
| --- | --- |
| Pull remote schema into `supabase/migrations` | `npm run db:pull` |
| Create a migration | `npm run db:migration:new -- name` |
| Diff local changes into a migration | `npm run db:diff -- name` |
| Rebuild local DB from migrations | `npm run db:reset` |
| Apply migrations to remote | `npm run db:push` |
| Generate TS types | `npm run db:types` |

## API (NestJS)

The former Edge Functions are NestJS routes: `POST /<function-name>` with the same JSON as before (errors are `{ "error": "..." }`).
`trip-share` and `list-budpay-banks` also serve `GET`. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in `.env` (no longer injected).

```bash
npm run start:dev   # watch mode
npm run build && npm run start:prod
```

## App connection

The app (`limpopo-app`) connects via `src/lib/supabase.ts` using the project URL and anon key; it does not need this repo at runtime.
