import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

describe('safe user relation includes', () => {
  it('does not use full-user includes in source files', () => {
    const sourceRoot = join(__dirname, '..', '..');
    const unsafeRelationNames = [
      'user',
      'author',
      'assignee',
      'reviewer',
      'actor',
    ];
    const unsafeIncludePattern = new RegExp(
      `(${unsafeRelationNames.join('|')})\\s*:\\s*true`,
    );

    const offenders = listTypeScriptFiles(sourceRoot)
      .filter((file) => !file.includes(`${join('generated', 'prisma')}`))
      .flatMap((file) => {
        const content = readFileSync(file, 'utf8');
        return content
          .split(/\r?\n/)
          .map((line, index) => ({ line, lineNumber: index + 1 }))
          .filter(({ line }) => unsafeIncludePattern.test(line))
          .map(({ line, lineNumber }) => `${file}:${lineNumber}: ${line.trim()}`);
      });

    expect(offenders).toEqual([]);
  });
});

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      return listTypeScriptFiles(fullPath);
    }

    return fullPath.endsWith('.ts') ? [fullPath] : [];
  });
}
