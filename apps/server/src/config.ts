import { z } from "zod";

const environment = z.object({
  DATABASE_URL: z.url().default("postgresql://mafia:mafia@127.0.0.1:5432/mafia"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  STATIC_DIR: z.string().optional(),
});

export type ServerConfig = z.infer<typeof environment>;

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): ServerConfig =>
  environment.parse(source);
