import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

export function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function writeTempFile(
  prefix: string,
  content: string,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-agent-"));
  const filePath = path.join(dir, `${prefix}.md`);
  await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  return filePath;
}
