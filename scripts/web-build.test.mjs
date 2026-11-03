import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { URL, fileURLToPath } from "node:url";
import { build } from "vite";

test("web production chunks stay below Vite's default 500 kB warning threshold", async () => {
  const result = await build({
    root: fileURLToPath(new URL("../apps/web/", import.meta.url)),
    logLevel: "silent",
    build: { write: false },
  });
  const chunks = result.output.filter((file) => file.type === "chunk");
  assert.ok(
    chunks.some((chunk) => chunk.isEntry),
    "must build the real application entry",
  );
  for (const chunk of chunks) {
    assert.ok(
      Buffer.byteLength(chunk.code) <= 500_000,
      `${chunk.fileName} exceeds the default chunk warning limit`,
    );
  }
  const eager = new Set();
  const visit = (chunk) => {
    if (eager.has(chunk)) return;
    eager.add(chunk);
    for (const imported of chunk.imports) {
      const dependency = chunks.find((candidate) => candidate.fileName === imported);
      if (dependency) visit(dependency);
    }
  };
  chunks.filter((chunk) => chunk.isEntry).forEach(visit);
  for (const pattern of [/\/RulesBookContent\.tsx$/, /\/node_modules\/vgpu\//]) {
    const owners = chunks.filter((chunk) =>
      Object.keys(chunk.modules).some((id) => pattern.test(id)),
    );
    assert.ok(owners.length > 0, `${pattern} must remain in the real build`);
    assert.ok(
      owners.every((chunk) => !eager.has(chunk)),
      `${pattern} must stay lazy-loaded`,
    );
  }
});
