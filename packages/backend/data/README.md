# `@tramio/backend` data directory

Filesystem-backed catalog assets are mounted here. The structure mirrors
the on-device layout (`packs/{bundleId}/{version}/...`) so authoring tools
and the backend can share fixtures without translation.

```
data/
  packs/
    {bundleId}/
      {version}/
        manifest.json
        route.json
        ...
```

Tests construct stores with `assetRoot: <abs path>` pointing at any
directory matching this layout (typically a per-test fixture directory).
