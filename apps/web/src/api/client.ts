export interface RemoteGameEvent {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
  readonly seat?: number;
  readonly payload: Record<string, unknown>;
  readonly secret: boolean;
  readonly createdAt: string;
}

export const createRemoteGame = async (name: string): Promise<string> => {
  const response = await fetch("/api/games", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error("Unable to create the persisted game");
  const body = (await response.json()) as { gameId: string };
  return body.gameId;
};

export const appendRemoteEvent = async (
  gameId: string,
  event: {
    readonly idempotencyKey: string;
    readonly type: string;
    readonly phase: string;
    readonly seat?: number;
    readonly payload: Record<string, unknown>;
    readonly secret: boolean;
  },
): Promise<void> => {
  const response = await fetch(`/api/games/${gameId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error("Unable to persist the game event");
};

export const readRemoteLog = async (gameId: string): Promise<readonly RemoteGameEvent[]> => {
  const response = await fetch(`/api/games/${gameId}/events`);
  if (!response.ok) throw new Error("Unable to load the game log");
  const body = (await response.json()) as { events: readonly RemoteGameEvent[] };
  return body.events;
};
