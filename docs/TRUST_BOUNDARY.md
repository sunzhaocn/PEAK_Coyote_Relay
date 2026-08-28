# Trusted proxy boundary

## Supported production topology

```text
Untrusted client
      |
      | HTTPS / WSS
      v
    Caddy
      |
      | private Docker network
      v
  Bun relay
```

The relay uses proxy headers to recover the original client IP and determine whether an administrator request arrived through HTTPS. In the supplied deployment topology this is intentional: Caddy is the only public entry point and overwrites `X-Coyote-Client-IP`; standard reverse-proxy headers carry the external protocol.

## Why direct exposure is different

If an operator adds a public Docker `ports:` mapping to the `relay` service or otherwise exposes Bun directly, an untrusted client can supply forwarding headers itself. IP-based block/rate policy and the proxy-derived HTTPS decision must then be considered untrusted.

Therefore:

- production Compose keeps relay on `expose`, not public `ports`;
- public traffic terminates at Caddy;
- do not place another untrusted proxy in front without defining which hop overwrites forwarding headers;
- direct Bun exposure is for controlled development only, not an equivalent production topology.

This is a deployment trust contract, not merely a performance recommendation.
