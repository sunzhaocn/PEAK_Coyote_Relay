# Security policy

## Production deployment boundary

The supported public deployment model is:

```text
Internet -> Caddy (public HTTPS/WSS) -> private Docker network -> Bun relay
```

The Bun relay trusts proxy-provided client/protocol headers (`X-Coyote-Client-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`) for IP policy and HTTPS/admin checks. This is safe only when untrusted clients cannot connect directly to the Bun relay and the trusted reverse proxy overwrites those headers.

The supplied Compose files intentionally use `expose` for the relay service rather than publishing its internal port. **Do not add a public `ports:` mapping to the relay service in production.** See `docs/TRUST_BOUNDARY.md`.

## Administrator bootstrap

The server code has a compatibility fallback of `admin/admin` when no initial credentials are supplied. The supplied deployment scripts also bootstrap that account and force a password change on first login. For public deployments, complete the password change immediately and never commit `.env`, `.coyote-deploy.env`, `security.json` or certificate/private-key material.

Plain HTTP administration is rejected by default (`ADMIN_ALLOW_INSECURE_HTTP=false`). Do not enable it on an untrusted network.

## Reporting vulnerabilities

Do not post administrator credentials, private keys, session tokens, client logs or private deployment data in public issues. Provide a minimal reproduction with secrets redacted.
