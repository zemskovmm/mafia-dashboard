import { z } from "zod";

export const composeAppVersion = (packageVersion: unknown, buildIndex: number): string => {
  const version = z
    .string()
    .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
    .parse(packageVersion);
  const [major, minor] = version
    .split(".")
    .map((value) => z.int().nonnegative().parse(Number(value)));
  return `${major}.${minor}.${z.int().nonnegative().parse(buildIndex)}`;
};
