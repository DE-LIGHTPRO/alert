import { rmSync } from "node:fs";
import { join } from "node:path";

export default async function globalTeardown() {
  globalThis.__anvil?.kill();
  rmSync(join(import.meta.dirname, ".addresses.json"), { force: true });
}
