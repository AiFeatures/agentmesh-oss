# Writing Adapters

Use `@agentmesh/adapter-interface` to build adapters that react to hub events.

## Interface

Implement `AgentMeshAdapter`:

```ts
export interface AgentMeshAdapter {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
  onAgentRegistered(event: AgentRegisteredEvent): Promise<void>;
  onClaimCreated(event: ClaimCreatedEvent): Promise<void>;
  onHandoffCreated(event: HandoffCreatedEvent): Promise<void>;
  onBlockerCreated(event: BlockerCreatedEvent): Promise<void>;
  onBlockerResolved(event: BlockerResolvedEvent): Promise<void>;
}
```

## Event Types

Available payload types:

- `AgentRegisteredEvent`
- `ClaimCreatedEvent`
- `HandoffCreatedEvent`
- `BlockerCreatedEvent`
- `BlockerResolvedEvent`

## Example

See `packages/adapter-interface/src/examples/console-adapter.ts`.

## Recommended Practices

- Keep handlers idempotent
- Avoid blocking operations in event handlers
- Track adapter health and surface failures
- Use retries with bounded backoff for external calls
- Log structured context (`workspace_id`, entity IDs)

## Integration Pattern

Typical flow:

1. Subscribe to hub WebSocket events.
2. Map hub event names to adapter methods.
3. Invoke adapter handlers with typed payloads.
4. Handle failures without crashing the hub process.

See `examples/custom-adapter/README.md` for a minimal event bridge skeleton.
