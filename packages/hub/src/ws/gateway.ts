import type { WebSocket } from "ws";

const sockets = new Set<WebSocket>();
const socketWorkspaces = new WeakMap<WebSocket, Set<string>>();
const socketEventFilters = new WeakMap<WebSocket, Set<string>>();

export function registerSocket(socket: WebSocket): void {
  sockets.add(socket);
  socket.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as {
        type?: string;
        workspace?: string;
        events?: string[];
      };
      if (msg.type === "subscribe" && typeof msg.workspace === "string") {
        let subs = socketWorkspaces.get(socket);
        if (!subs) {
          subs = new Set();
          socketWorkspaces.set(socket, subs);
        }
        subs.add(msg.workspace);
      } else if (msg.type === "unsubscribe" && typeof msg.workspace === "string") {
        socketWorkspaces.get(socket)?.delete(msg.workspace);
      } else if (msg.type === "filter_events" && Array.isArray(msg.events)) {
        const filters = new Set<string>();
        for (const e of msg.events) {
          if (typeof e === "string") filters.add(e);
        }
        socketEventFilters.set(socket, filters);
      } else if (msg.type === "clear_filter") {
        socketEventFilters.delete(socket);
      }
    } catch {
      // ignore non-JSON messages
    }
  });
  socket.on("close", () => sockets.delete(socket));
}

export function drainSockets(): void {
  for (const socket of sockets) {
    try {
      socket.close(1001, "Server shutting down");
    } catch {
      // ignore
    }
  }
  sockets.clear();
}

export function broadcast(event: string, data: Record<string, unknown>): void {
  const payload = JSON.stringify({ event, data, ts: new Date().toISOString() });
  const workspace = typeof data.workspace === "string" ? data.workspace : null;
  for (const socket of sockets) {
    if (socket.readyState === 1) {
      const subs = socketWorkspaces.get(socket);
      if (subs && subs.size > 0 && workspace && !subs.has(workspace)) {
        continue;
      }
      const eventFilter = socketEventFilters.get(socket);
      if (eventFilter && eventFilter.size > 0 && !eventFilter.has(event)) {
        continue;
      }
      try {
        socket.send(payload);
      } catch (err) {
        console.error(`[ws] broadcast send failed for event=${event}:`, err);
        sockets.delete(socket);
      }
    }
  }
}

export function getSocketCount(): number {
  return sockets.size;
}
