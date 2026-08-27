import assert from "node:assert/strict";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Module-graph integrity (docs/session-findings.md §15): splitting the
 * extension into modules broke Pi at load time because a sibling import pointed
 * at a file that was not there. Nothing else in the suite fails on a dangling
 * relative import in a module no test happens to load.
 */

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

test("every relative import in the extension resolves to a real file", async () => {
  const files = await sourceFiles(EXTENSION_DIR);
  assert.ok(files.length > 10, `expected the module set, found ${files.length}`);

  const dangling: string[] = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const specifiers = [
      ...source.matchAll(/from\s+"(\.[^"]+)"/g),
      ...source.matchAll(/import\("(\.[^"]+)"\)/g),
    ].map((match) => match[1] as string);

    for (const specifier of specifiers) {
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!existsSync(resolved)) {
        dangling.push(`${path.relative(EXTENSION_DIR, file)} → ${specifier}`);
      }
    }
  }

  assert.deepEqual(dangling, []);
});

test("the package manifest points at the real entrypoint", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(EXTENSION_DIR, "package.json"), "utf8"),
  );
  const entrypoints: string[] = manifest.pi?.extensions ?? [];
  assert.ok(entrypoints.length > 0, "expected pi.extensions in package.json");
  for (const entry of entrypoints) {
    assert.ok(
      existsSync(path.resolve(EXTENSION_DIR, entry)),
      `missing extension entrypoint ${entry}`,
    );
  }
});
