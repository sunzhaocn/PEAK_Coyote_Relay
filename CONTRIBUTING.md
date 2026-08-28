# Contributing

Keep changes separated by responsibility:

- relay/protocol/security core: `server/v4-server.ts`
- administration UI: `server/admin.html`, `server/admin.js`, `server/admin.css`
- deployment: `deploy.*`, `manage.*`, Compose files and Dockerfile
- documentation/configuration contracts: `docs/`, `.env.example`

Protocol routing changes and administrator/security changes should not be mixed in one commit unless they are inseparable.

Before submitting:

```bash
bun build server/v4-server.ts --target=bun --outfile=/tmp/coyote-relay-check.js
bash -n deploy.sh manage.sh
```

Also validate every Compose file with `docker compose ... config` when Docker is available.

Any change that publishes the Bun relay port directly must be treated as a security-model change and must update `SECURITY.md` and `docs/TRUST_BOUNDARY.md`.
