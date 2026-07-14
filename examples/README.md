# Examples

Three small [TanStack Start](https://tanstack.com/start) apps showing the
modelschemas packages in real use. Each links to the workspace packages by
`workspace:*` reference — run `bun install` at the repo root first.

All three are deployed with the main site as static SPA builds, served at
`https://modelschemas.com/examples/<name>/` — `bun run build` at the repo
root builds them (`scripts/build-examples.ts`) and copies each `dist/client`
into the main build's assets, so both `bun run deploy` and the
GitHub-connected Workers Build ship them automatically.

| Example                                | Shows                                                                                                                                   | Port |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| [schema-studio](./schema-studio)       | `@modelschemas/vite` — schemas pulled at dev time, committed, verified offline at build; rendered as generative UI (schema-driven form) | 3201 |
| [image-dimensions](./image-dimensions) | `@modelschemas/client` — live discovery of image models; supported dimensions extracted from each input schema and drawn to scale       | 3202 |
| [video-composer](./video-composer)     | `@modelschemas/client` — video request builder whose model/aspect-ratio/duration pickers only offer values the schema allows            | 3203 |

```bash
bun install                      # repo root — links workspace packages
cd examples/schema-studio        # or image-dimensions / video-composer
bun run dev
```

All three fetch from the live service at `https://modelschemas.com` by
default. Point them at another deployment (e.g. a local dev server with
freshly synced providers) with:

```bash
MODELSCHEMAS_URL=http://localhost:3100 bun run dev
```

No CORS setup is needed anywhere: in production the examples are same-origin
with the API; in dev the vite server proxies `/v1` to `MODELSCHEMAS_URL`
(schema-studio instead pulls schemas at dev time via the
`@modelschemas/vite` plugin and verifies them offline at build).
