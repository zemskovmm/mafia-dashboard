export interface GameEvent {
  readonly gameId: string;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly phase: string;
  readonly seat?: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly duplicate: boolean;
  readonly parentEventId: string | null;
  readonly replayVersion: number;
  readonly stateHashAfter: string | null;
}
