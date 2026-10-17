export class DeletedGameError extends Error {
  public readonly code = "game_deleted";

  public constructor(gameId: string) {
    super(`Game ${gameId} was deleted`);
    this.name = "DeletedGameError";
  }
}
