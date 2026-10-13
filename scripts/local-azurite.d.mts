export interface LocalAzuriteFixture {
  readonly environment: Readonly<Record<string, string>>;
  stop(): Promise<void>;
}
export function startAzurite(options?: {
  readonly mode?: "test" | "dev";
  readonly rootDirectory?: string;
}): Promise<LocalAzuriteFixture>;
