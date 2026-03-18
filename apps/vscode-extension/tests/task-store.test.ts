import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

describe("task store source", () => {
  it("waits for socket snapshots instead of repainting the monitor on every event frame", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(currentDir, "../src/core/task-store.ts");
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /if \(frame\.type === "event"\) {\s*this\.snapshot = {\s*\.\.\.this\.snapshot,\s*connection: "connected",\s*};\s*return;\s*}/s);
    assert.match(source, /this\.snapshot = applyDaemonSnapshot\(this\.snapshot, frame\.snapshot, "connected"\);/);
    assert.doesNotMatch(source, /lastUpdatedAt: frame\.event\.timestamp/);
  });
});
