import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const projectRoot = resolve('.');
const excludedDirectories = new Set(['.git', 'node_modules', 'scripts', 'tests', 'vendor']);
const excludedFiles = new Set(['playwright.config.js', 'vitest.config.js']);
const runtimeExtensions = new Set(['.css', '.html', '.js', '.mjs']);
const dependencyHosts = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'esm.sh',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'tessdata.projectnaptha.com',
  'unpkg.com',
];

const allowedExternalReferences = new Map([
  ['export.js', new Set([
    'https://veil.simoneamico.com',
  ])],
  ['index.html', new Set([
    'https://gigazine.net/gsc_news/en/20260401-veil-pdf/',
    'https://github.com/simoneamico-ux-dev/veil',
    'https://ko-fi.com/simoneamico',
    'https://news.ycombinator.com/item?id=47529306',
    'https://opensource.org/licenses/MIT',
    'https://schema.org',
    'https://simoneamico.com',
    'https://simoneamico.com/docs/featured/veil/',
    'https://veil.simoneamico.com/',
    'https://veil.simoneamico.com/#software',
    'https://veil.simoneamico.com/icon/og-image.png',
    'https://veil.simoneamico.com/reader',
  ])],
  ['reader.html', new Set([
    'https://veil.simoneamico.com/icon/og-image.png',
    'https://veil.simoneamico.com/reader',
  ])],
]);

const executableResourcePatterns = [
  /\bimport\s+(?:[^\n'";]+?\s+from\s+)?['"](?:https?:)?\/\//,
  /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"](?:https?:)?\/\//,
  /\bimport\s*\(\s*['"](?:https?:)?\/\//,
  /\bfetch\s*\(\s*['"](?:https?:)?\/\//,
  /\bnew\s+(?:SharedWorker|Worker|URL)\s*\(\s*['"](?:https?:)?\/\//,
  /<script\b[^>]+src=['"](?:https?:)?\/\//i,
  /<link\b(?=[^>]*rel=['"](?:modulepreload|preload|stylesheet)['"])[^>]+href=['"](?:https?:)?\/\//i,
  /(?:@import\s+|url\s*\(\s*)['"]?(?:https?:)?\/\//i,
];

function walk(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    if (entry.isFile() && excludedFiles.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && runtimeExtensions.has(extname(entry.name))) files.push(path);
  }

  return files;
}

export function inspectRuntimeSource(source, projectPath) {
  const violations = [];

  for (const host of dependencyHosts) {
    if (source.includes(host)) {
      violations.push(`${projectPath} references external dependency host ${host}`);
    }
  }

  for (const pattern of executableResourcePatterns) {
    if (pattern.test(source)) {
      violations.push(`${projectPath} loads an external runtime resource matching ${pattern}`);
    }
  }

  const allowed = allowedExternalReferences.get(projectPath) || new Set();
  const externalReferences = source.match(/https?:\/\/[^\s'"`<>\\)]+/g) || [];
  for (const reference of new Set(externalReferences)) {
    if (!allowed.has(reference)) {
      violations.push(`${projectPath} contains unapproved external reference ${reference}`);
    }
  }

  if (/['"`](\/\/[^\s'"`<>\\)]+)/.test(source)) {
    violations.push(`${projectPath} contains a protocol-relative external reference`);
  }

  return violations;
}

export function findRuntimeOriginViolations(root = projectRoot) {
  return walk(root).flatMap(path => {
    const projectPath = relative(root, path).split('\\').join('/');
    return inspectRuntimeSource(readFileSync(path, 'utf8'), projectPath);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === join(projectRoot, 'scripts/check-runtime-origins.mjs')) {
  const violations = findRuntimeOriginViolations();
  if (violations.length) throw new Error(violations.join('\n'));
  console.log('Verified same-origin runtime sources');
}
