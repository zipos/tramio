# Dev catalog keys

| File                       | Commit?             | Purpose                                                             |
| -------------------------- | ------------------- | ------------------------------------------------------------------- |
| `catalog-public-key.json`  | Yes                 | SPKI pinned in the app (`packages/clients/src/catalogPublicKey.ts`) |
| `catalog-signing-key.json` | **No** (gitignored) | Private key for `backend:dev` + `pack:build-warsaw`                 |

## First-time / fresh clone

```bash
node tooling/generate-dev-catalog-key.mjs
npm run pack:build-warsaw
```

That rewrites the public key fixture and resigns the Warsaw pack. Commit the updated
`catalog-public-key.json` and pack artifacts together; leave the private key local.
