# Backend, Clients and Storage

## Backend (`packages/backend`)

Fastify 5 server in `src/server.ts`. Start with `npm run backend:dev`.

| Route                                                 | Purpose                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /v1/catalog`                                     | Signed list of available bundles                                                    |
| `GET /v1/catalog/:bundle/:version/manifest.lock.json` | Signed lock for one pack                                                            |
| `GET /v1/catalog/:bundle/:version/asset/*`            | Pack asset, supports HTTP Range                                                     |
| `GET /v1/gtfs/:cityId/latest`                         | GTFS snapshot pointer                                                               |
| `GET /v1/entitlements`                                | Entitlements for a device                                                           |
| `POST /v1/entitlements/receipt`                       | Store receipt. Default mode `reject` (fail closed), `stub` grants everything in dev |
| `POST /v1/entitlements/restore`                       | Restore purchases                                                                   |
| `GET /v1/moderation`                                  | Moderation snapshot                                                                 |

- Persistence: in-memory maps (`src/store.ts`) plus a filesystem overlay for pack assets.
- Identity: `X-Device-Id` header only.
- Every response is a signed envelope.

## Clients (`packages/clients`)

- `catalog-client.ts` and `entitlement-client.ts` call the routes above and verify every envelope with the pinned Ed25519 key.
- `http-client.ts` is the single network chokepoint:
  - `TourActiveBlockError`: any non-loopback request during an active tour.
  - `MeteredConnectionBlockError`: downloads on metered networks unless the user opts in.

## Storage (`packages/storage`)

- **SQLite** (`schema.ts`, `migrations.ts`): `pack_progress`, `entitlement_cache`, `lru_access`, `moderation_snapshot`, `device_id`, `license_tokens`. `expo-sqlite` on device, `better-sqlite3` in tests.
- **Downloader** (`downloader-core.ts`): staged download with resume, streaming SHA-256, atomic stage-and-rename.
- **Integrity** (`packIntegrity.ts`, `packLoader.ts`, `signatureVerify.ts`): signature and hash checks before load.
- **Budget** (`budget.ts`): LRU eviction by last access, default 2 GiB, never evicts the pack of the active tour.
