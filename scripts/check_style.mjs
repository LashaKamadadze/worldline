// TigerStyle checks that tsc cannot express:
//  - no function longer than 70 lines (src/ only),
//  - no line longer than 100 columns (src/ and test/),
//  - no recursion inside src/ (a function calling itself by name).
// Exit code 1 lists every violation. Run with `node scripts/check_style.mjs`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const FUNCTION_LINES_MAX = 70;
const LINE_COLUMNS_MAX = 100;
const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: node scripts/check_style.mjs <dir>...');
  process.exit(2);
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'else', 'do', 'try', 'return']);
const violations = [];

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const skip = ['node_modules', 'dist', 'module_bindings', 'generated'];
      if (skip.includes(entry)) continue;
      if (entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) stack.push(path);
      else if (/\.(ts|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
    }
  }
  return out;
}

const IDENT = '[A-Za-z_$][\\w$]*';
const MODIFIERS = '(?:static\\s+|private\\s+|public\\s+|get\\s+|set\\s+|async\\s+)*';
const FUNCTION_START = new RegExp(
  '^\\s*(?:export\\s+)?(?:async\\s+)?(?:' +
    `function\\s*\\*?\\s*(${IDENT})` +
    `|${MODIFIERS}\\*?\\s*(#?${IDENT})\\s*(?:<[^>]*>)?\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{\\s*$` +
    `|(?:const|let)\\s+(${IDENT})\\s*=\\s*(?:async\\s*)?` +
    `(?:\\([^)]*\\)|${IDENT})\\s*(?::\\s*[^=]+)?=>\\s*\\{\\s*$` +
    ')'
);

function checkFile(path, isSource) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.length > LINE_COLUMNS_MAX) {
      const where = `${relative(process.cwd(), path)}:${i + 1}`;
      violations.push(`${where}: line has ${line.length} columns (max ${LINE_COLUMNS_MAX})`);
    }
  });
  if (!isSource) return;
  // Function length: match a function header ending in `{`, then find its closing brace by depth.
  for (let i = 0; i < lines.length; i++) {
    const m = FUNCTION_START.exec(lines[i]);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? m[3];
    if (KEYWORDS.has(name)) continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j].replace(/'[^']*'|"[^"]*"|`[^`]*`|\/\/.*$/g, '')) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    const length = end - i + 1;
    if (length > FUNCTION_LINES_MAX) {
      const where = `${relative(process.cwd(), path)}:${i + 1}`;
      violations.push(`${where}: function ${name} is ${length} lines (max ${FUNCTION_LINES_MAX})`);
    }
    if (name && !name.startsWith('#')) {
      const body = lines
        .slice(i + 1, end)
        .map(l => l.replace(/'[^']*'|"[^"]*"|`[^`]*`|\/\/.*$/g, ''))
        .join('\n');
      const selfCall = new RegExp(`(?<![\\w$.#])${name.replace('$', '\\$')}\\s*\\(`);
      if (selfCall.test(body)) {
        violations.push(`${relative(process.cwd(), path)}:${i + 1}: function ${name} recurses`);
      }
    }
  }
}

for (const root of roots) {
  const isSource = !/(^|\/)(test(s)?|live-tests|browser-tests)(\/|$)/.test(root);
  for (const file of walk(root)) checkFile(file, isSource);
}

if (violations.length) {
  console.error(violations.join('\n'));
  console.error(`\n${violations.length} style violation(s)`);
  process.exit(1);
}
console.log('style: ok');
