import type { WebSocket } from "ws";

const sockets = new Set<WebSocket>();

export function registerSocket(socket: WebSocket): void {
  sockets.add(socket);
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
  for (const socket of sockets) {
    if (socket.readyState === 1) {
      try {
        socket.send(payload);
      } catch {
        sockets.delete(socket);
      }
    }
  }
}
