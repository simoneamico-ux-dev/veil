import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve('.');
const workerSource = readFileSync(resolve(projectRoot, 'sw.js'), 'utf8');
const revisionPatterns = {
  shell: /const SHELL_CACHE_REVISION = '([0-9a-f]{12})';/,
  runtime: /const RUNTIME_CACHE_REVISION = '([0-9a-f]{12})';/,
};
const revisionMatches = {
  shell: workerSource.match(revisionPatterns.shell),
  runtime: workerSource.match(revisionPatterns.runtime),
};

if (!revisionMatches.shell || !revisionMatches.runtime) {
  throw new Error('Service worker cache revisions are missing');
}

function extractPrecacheUrls(name) {
  const match = workerSource.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`));
  if (!match) throw new Error(`Missing ${name}`);
  return [...match[1].matchAll(/'(\.\/[^']*)'/g)].map(result => result[1]);
}

function toProjectPath(url) {
  return url === './' ? 'index.html' : url.slice(2);
}

function contentRevision(seed, paths) {
  const hash = createHash('sha256');
  hash.update(seed);

  for (const path of [...new Set(paths)].sort()) {
    const bytes = readFileSync(resolve(projectRoot, path));
    hash.update(`\n${path}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }

  return hash.digest('hex').slice(0, 12);
}

const shellUrls = extractPrecacheUrls('SHELL_PRECACHE_URLS');
const runtimeUrls = extractPrecacheUrls('RUNTIME_PRECACHE_URLS');
const normalizedWorker = workerSource
  .replace(revisionPatterns.shell, "const SHELL_CACHE_REVISION = '<revision>';")
  .replace(revisionPatterns.runtime, "const RUNTIME_CACHE_REVISION = '<revision>';");
const expectedRevisions = {
  shell: contentRevision(normalizedWorker, shellUrls.map(toProjectPath)),
  runtime: contentRevision(
    JSON.stringify(runtimeUrls),
    [...runtimeUrls.map(toProjectPath), 'vendor/manifest.json'],
  ),
};

const mismatches = [];
for (const name of ['shell', 'runtime']) {
  const current = revisionMatches[name][1];
  const expected = expectedRevisions[name];
  if (current !== expected) {
    mismatches.push(`${name} cache revision ${current} does not match content ${expected}`);
  }
}
if (mismatches.length) throw new Error(mismatches.join('\n'));

console.log(
  `Verified service worker cache revisions ${expectedRevisions.shell}/${expectedRevisions.runtime}`,
);
