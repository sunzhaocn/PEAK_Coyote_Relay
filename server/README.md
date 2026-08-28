# Relay server source

`v4-server.ts` is the authoritative Bun relay/server implementation. `admin.html`, `admin.js` and `admin.css` are the authenticated administration frontend served by that process.

Current source version: see repository-root `VERSION.txt`.

## Security assumptions

The server is designed to run behind the supplied Caddy reverse-proxy topology in production. It consumes forwarding headers for original-client IP and HTTPS decisions; those headers are trusted only because the provided Compose topology does not publish the Bun relay port directly. See `../docs/TRUST_BOUNDARY.md` before changing networking/deployment behavior.

## Versioning

The relay version is independent from the PEAK Coyote desktop and plugin versions. Keep the `stats()` version in `v4-server.ts` and repository-root `VERSION.txt` synchronized for releases.
