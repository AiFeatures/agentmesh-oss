# Security

## Authentication Model

AgentMesh OSS uses shared-secret bearer authentication for all API routes under `/api/v1`.

- Header: `Authorization: Bearer <shared-secret>`
- Secret source: `~/.agentmesh/secret`

If the file does not exist, the hub generates a random secret at first startup.

## Transport Guidance

- Run behind TLS in production (reverse proxy or ingress)
- Restrict network exposure of the hub port
- Rotate shared secrets on schedule or after incident response

## Input Validation

- Route bodies use JSON schema validation
- Unknown properties are rejected on mutation routes
- Length and enum constraints reduce malformed payload risks

## Data Storage

- SQLite with WAL mode and foreign keys enabled
- Sensitive secrets are not stored in the application database

## Logging and Audit

- Hub writes audit rows for key mutations
- Audit events can be streamed over WebSocket (`audit.logged`)

## Dependency and Code Hygiene

Before merging changes:

```bash
pnpm lint
pnpm test
pnpm build
```

## Vulnerability Reporting

Please report suspected vulnerabilities privately to repository maintainers.
Do not open public issues with exploit details.
