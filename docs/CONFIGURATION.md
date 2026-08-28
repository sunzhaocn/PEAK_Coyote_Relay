# Configuration semantics

`server/v4-server.ts` is configured through environment variables plus persisted runtime/security state in `DATA_DIR`.

## Core network settings

- `PORT`: Bun relay listening port inside its network namespace; default `9998`.
- `HOST`: bind address; default `0.0.0.0`.
- `PREFIX`: relay WebSocket path prefix; default `/`.
- `DATA_DIR`: persistent security/log/report data; default `/data`.

## Connection limits

- `MAX_CONNECTIONS`: global connection ceiling.
- `MAX_CONNECTIONS_PER_IP`: per-client-IP ceiling; depends on the trusted-proxy boundary described in `TRUST_BOUNDARY.md`.
- `MAX_CLIENTS_PER_CONTROLLER`: attached DG-LAB clients per controller.
- `MAX_MESSAGES_PER_SECOND`: per-connection message-rate ceiling.
- `MAX_WS_HANDSHAKES_PER_MINUTE`: per-IP WebSocket handshake ceiling.
- `IDLE_TIMEOUT`: controller idle timeout in milliseconds.

## Message-size semantics

The current source intentionally initializes `MAX_MESSAGE_BYTES` with a **minimum startup value of 256 KiB** and a hard upper ceiling of 1 MiB. Persisted runtime settings can later be normalized within the administrator-configurable 16 KiB–1 MiB range.

This distinction is documented because setting `MAX_MESSAGE_BYTES` below `262144` in the startup environment alone does not lower the initial fallback below 256 KiB.

## Administrator settings

- `ADMIN_USER`: bootstrap username.
- `ADMIN_INITIAL_PASSWORD`: bootstrap password used only when creating/resetting security state.
- `ADMIN_SESSION_HOURS`: session lifetime.
- login/API rate-limit variables control brute-force and admin API throttling.
- `ADMIN_ALLOW_INSECURE_HTTP`: default `false`; enabling it changes the security model.

The server has an `admin/admin` compatibility fallback if no bootstrap environment is supplied. Public deployments must change the forced initial password immediately. `.env.example` deliberately uses a non-secret placeholder rather than a real deployable password.

## Persistent state precedence

Once `/data/security.json` exists, administrator/security runtime settings are persisted there. Operators should not assume every environment-variable change overrides an already persisted runtime value. Use the administration interface or intentionally reset/migrate state when changing persisted settings.
