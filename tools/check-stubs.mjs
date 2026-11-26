// X4: fail CI if shipped code contains stubs, placeholders or TODOs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['apps/mobile/src', 'packages', 'relay/src'];
const SKIP = /(node_modules|[\/]test[\/]|\.test\.|[\/]ios[\/]CONTRACT\.md$|[\/]android[\/]build[\/])/;
const BAD = [/\bTODO\b/, /\bFIXME\b/, /\bXXX\b/, /not implemented/i, /\bplaceholder data\b/i, /lorem ipsum/i, /\bstub(bed)?\b/i];
const EXT = /\.(ts|tsx|kt|java|json)$/;
const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(p)) continue;
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (EXT.test(name)) {
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (BAD.some((re) => re.test(line))) hits.push(`${relative('.', p)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
}
for (const r of ROOTS) walk(r);
if (hits.length) {
  console.error(`Stub/TODO check failed (${hits.length}):\n${hits.join('\n')}`);
  process.exit(1);
}
console.log('stub check: clean');
