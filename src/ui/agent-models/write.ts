import { promises as fs } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../utils.ts';

export async function setProfileModel(
  filePath: string,
  model: string | null,
): Promise<string | null> {
  let temporary: string | undefined;
  try {
    const target = await fs.realpath(filePath);
    const content = await fs.readFile(target, 'utf8');
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    const end = lines.indexOf('---', 1);
    if (lines[0] !== '---' || end < 0) {
      return 'Profile must have a complete frontmatter block.';
    }

    const matches: number[] = [];
    for (let index = 1; index < end; index++) {
      if (/^model:/.test(lines[index])) matches.push(index);
    }
    if (matches.length > 1) {
      return 'Profile has duplicate top-level model: lines.';
    }
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
    const index = matches[0];
    if (index === undefined && Object.hasOwn(frontmatter, 'model')) {
      return 'Unsupported model key; use a single top-level model: line.';
    }
    if (model === null) {
      if (index === undefined) return null;
      lines.splice(index, 1);
    } else {
      const value = JSON.stringify(model);
      if (index === undefined) lines.splice(1, 0, `model: ${value}`);
      else lines[index] = `model: ${value}`;
    }

    const updated = lines.join(newline);
    const expected = { ...frontmatter };
    if (model === null) delete expected.model;
    else expected.model = model;
    // A line edit must not absorb multiline values or change unrelated fields.
    if (!isDeepStrictEqual(parseFrontmatter(updated).frontmatter, expected)) {
      return 'Unsupported model value; use a single-line model: value.';
    }

    const { mode } = await fs.stat(target);
    const tempPath = `${target}.herdr-agent-models.tmp`;
    const file = await fs.open(tempPath, 'wx', mode);
    temporary = tempPath;
    try {
      await file.writeFile(updated);
      // chmod preserves permissions even when the process umask is stricter.
      await file.chmod(mode);
    } finally {
      await file.close();
    }
    await fs.rename(tempPath, target);
    temporary = undefined;
    return null;
  } catch (error) {
    return errorMessage(error);
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}
