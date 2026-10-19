# Cloudroom Connect relay

- The Cloudflare Worker `cloudroom-connect` on cloudroom.run: phone sign-in, Mac switching, and Mac-to-Mac access ([ADR 0185](../../../docs/adr/0185-cloudflare-for-cloudroom-connect.md), [0238](../../../docs/adr/0238-mac-to-mac-access-off-bb.md), [0258](../../../docs/adr/0258-switch-macs-from-settings.md)).
- Account, token scope, and IDs: [docs/external/cloudflare.md](../../../docs/external/cloudflare.md).
- `app.cloudroom.run` is the phone app's one address ([ADR 0268](../../../docs/adr/0268-one-phone-app-set-up-at-cloudroom-dev-m.md)). Its manifest and icons come from `../app/public`, uploaded as Worker assets on every deploy.

## Its own database

- D1 database `cloudroom-connect`, separate from the Supabase database.
- Its migrations live in `migrations/` with their own numbers (`0001`, `0002`, ...). Never put them in `docs/database/` or reuse Supabase numbers. Wrangler applies this folder in order.
- Keep migrations additive (new tables, nullable columns, indexes). The deployed Worker must work before and after each one.
- Only David approves applying them. `migrations apply` runs every pending one, so list them first and name each to him.
- Durable Object class changes need a new entry under `migrations` in `wrangler.jsonc`. That is a separate list from the D1 folder.

## Commands

From this folder, with `CLOUDFLARE_API_TOKEN` set to `CLOUDROOM_CONNECT_CF_API_TOKEN` from the root `.env.local`:

- Pending migrations: `npx wrangler d1 migrations list cloudroom-connect --remote`
- Apply, after David's OK: `npx wrangler d1 migrations apply cloudroom-connect --remote`
- Read-only query: `npx wrangler d1 execute cloudroom-connect --remote --command "SELECT ..."`
- Deploy, after `pnpm typecheck` and `pnpm test`: `npx wrangler deploy`
- Check: `curl -s -o /dev/null -w '%{http_code}' https://cloudroom.run/pair` returns `200`.

## Releases

- GUI releases don't deploy the relay. The [release-gui](../../../.agents/skills/release-gui/SKILL.md) skill checks it first.
- Apply migrations before deploying code that needs them. `gui/packages/tunnel-contract` is shared with the app, so change both sides together.
