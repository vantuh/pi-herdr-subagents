import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RESULT_FILE_MARKER = "HERDR_RESULT_FILE:";

export function makeHerdrAgentName(profileName: string): string {
  const base = profileName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 22) || "agent";
  return `${base}_${randomBytes(4).toString("hex")}`;
}

export function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function normalizeTools(rawTools: unknown): string[] | undefined {
  const tools = Array.isArray(rawTools)
    ? rawTools.map((tool) => String(tool).trim()).filter(Boolean)
    : typeof rawTools === "string"
      ? rawTools
          .split(",")
          .map((tool) => tool.trim())
          .filter(Boolean)
      : undefined;

  return tools && tools.length > 0 ? tools : undefined;
}

export function shouldCloseTab(lifecycle: "oneshot" | "persistent"): boolean {
  return lifecycle === "oneshot";
}

export function formatAgentOutput(
  output: string,
  tabLabel: string,
  closeError?: string,
): string {
  const text =
    output.trim() || `(Herdr agent ${tabLabel} finished with no visible output.)`;
  return closeError
    ? `${text}\n\nWarning: failed to close one-shot Herdr agent ${tabLabel}: ${closeError}`
    : text;
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

export async function createResultFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-agent-"));
  return path.join(dir, "result.md");
}

export function isManagedResultFile(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const relative = path.relative(os.tmpdir(), resolved);
  return (
    !relative.startsWith("..") &&
    relative.split(path.sep)[0]?.startsWith("herdr-agent-") === true &&
    path.basename(resolved) === "result.md"
  );
}

export function findResultFileMarker(prompt: string): string | undefined {
  const matches = [...prompt.matchAll(/^HERDR_RESULT_FILE:\s*(.+)$/gm)];
  const candidate = matches.at(-1)?.[1]?.trim();
  return candidate && isManagedResultFile(candidate) ? candidate : undefined;
}

export function assistantText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

export async function writeAgentResult(
  filePath: string,
  output: string,
): Promise<void> {
  if (!isManagedResultFile(filePath)) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, output, { encoding: "utf8", mode: 0o600 });
}

export async function readAgentResult(
  filePath: string | undefined,
): Promise<string | undefined> {
  if (!filePath || !isManagedResultFile(filePath)) return undefined;
  try {
    const output = await fs.readFile(filePath, "utf8");
    return output.trim() || undefined;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}
