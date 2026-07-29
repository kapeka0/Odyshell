# Tailnet-only test deployment

Tailscale Serve exposes the local Odyshell control plane to authenticated devices in the same
tailnet. It terminates HTTPS and proxies WebSocket upgrades, so both the agent API and outbound
connectors can use the resulting `https://...ts.net` URL.

Start Odyshell and enable the persistent proxy:

```powershell
docker compose up -d --build
tailscale serve --bg --yes http://127.0.0.1:4100
tailscale serve status
```

Configure the CLI with the HTTPS URL printed by Tailscale:

```powershell
ods login --server https://your-device.your-tailnet.ts.net --agent-key <agent-key> --admin-key <admin-key>
ods status
```

The endpoint is available only within the tailnet. This uses Tailscale Serve, not Funnel.

Disable the proxy without stopping Odyshell:

```powershell
tailscale serve off
```

The Docker Compose ports bind to `127.0.0.1`, so PostgreSQL and the raw HTTP control-plane port
are not exposed on the LAN.
