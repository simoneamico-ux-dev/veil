import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = join(projectRoot, 'vendor');
const manifestPath = join(vendorRoot, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const expectedFiles = new Set();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePath(path) {
  return path.split('\\').join('/');
}

function verifySource(source, label) {
  if (typeof source !== 'string' || !source) throw new Error(`Missing source for ${label}`);
  const resolvedSource = source.replaceAll('{language}', 'eng');
  const url = new URL(resolvedSource);
  if (url.protocol !== 'https:') throw new Error(`Non-HTTPS source for ${label}`);
  if (url.hostname === 'fonts.googleapis.com') throw new Error(`Mutable stylesheet source for ${label}`);
  if (resolvedSource === 'https://www.npmjs.com/org/tesseract.js-data') {
    throw new Error(`Mutable package listing source for ${label}`);
  }
}

function resolveProjectPath(path) {
  if (!path.startsWith('vendor/')) throw new Error(`Path outside vendor: ${path}`);

  const absolutePath = resolve(projectRoot, path);
  const vendorRelative = relative(vendorRoot, absolutePath);
  if (vendorRelative.startsWith('..') || isAbsolute(vendorRelative)) {
    throw new Error(`Path escapes vendor: ${path}`);
  }

  return absolutePath;
}

function walkFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${path}`);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unsupported vendor entry: ${path}`);
  }

  return files.sort();
}

function verifyFile(record) {
  const absolutePath = resolveProjectPath(record.path);
  const stats = lstatSync(absolutePath);
  if (!stats.isFile()) throw new Error(`Not a regular file: ${record.path}`);
  if (stats.size !== record.bytes) {
    throw new Error(`${record.path} has ${stats.size} bytes, expected ${record.bytes}`);
  }

  const digest = sha256(readFileSync(absolutePath));
  if (digest !== record.sha256) {
    throw new Error(`${record.path} has SHA-256 ${digest}, expected ${record.sha256}`);
  }

  expectedFiles.add(record.path);
}

function verifyTree(record) {
  const directory = resolveProjectPath(record.path);
  const files = walkFiles(directory);
  let totalBytes = 0;
  let material = '';

  for (const absolutePath of files) {
    const stats = lstatSync(absolutePath);
    const treeRelative = normalizePath(relative(directory, absolutePath));
    const digest = sha256(readFileSync(absolutePath));
    totalBytes += stats.size;
    material += `${treeRelative}\0${stats.size}\0${digest}\n`;
    expectedFiles.add(normalizePath(relative(projectRoot, absolutePath)));
  }

  if (files.length !== record.fileCount) {
    throw new Error(`${record.path} has ${files.length} files, expected ${record.fileCount}`);
  }
  if (totalBytes !== record.bytes) {
    throw new Error(`${record.path} has ${totalBytes} bytes, expected ${record.bytes}`);
  }

  const digest = sha256(material);
  if (digest !== record.sha256) {
    throw new Error(`${record.path} has tree SHA-256 ${digest}, expected ${record.sha256}`);
  }
}

function verifyMultipart(record) {
  const hash = createHash('sha256');
  let totalBytes = 0;

  for (const path of record.parts) {
    const absolutePath = resolveProjectPath(path);
    const stats = lstatSync(absolutePath);
    if (!stats.isFile()) throw new Error(`Not a regular file: ${path}`);
    const bytes = readFileSync(absolutePath);
    totalBytes += bytes.byteLength;
    hash.update(bytes);
    expectedFiles.add(path);
  }

  if (totalBytes !== record.bytes) {
    throw new Error(`${record.path} has ${totalBytes} bytes, expected ${record.bytes}`);
  }

  const digest = hash.digest('hex');
  if (digest !== record.sha256) {
    throw new Error(`${record.path} has SHA-256 ${digest}, expected ${record.sha256}`);
  }
}

function verifyTreeProvenance(asset) {
  if (!asset.sourceFiles && !asset.generatedFiles) return;
  if (!asset.tree) throw new Error(`${asset.id} provenance requires a tree`);

  const declaredPaths = new Set();
  for (const [path, source] of Object.entries(asset.sourceFiles || {})) {
    resolveProjectPath(path);
    verifySource(source, path);
    declaredPaths.add(path);
  }
  for (const path of asset.generatedFiles || []) {
    resolveProjectPath(path);
    declaredPaths.add(path);
  }

  const treePaths = walkFiles(resolveProjectPath(asset.tree.path))
    .map(path => normalizePath(relative(projectRoot, path)));
  if (
    treePaths.length !== declaredPaths.size
    || treePaths.some(path => !declaredPaths.has(path))
  ) {
    throw new Error(`${asset.id} provenance does not cover its complete tree`);
  }
}

function verifyLanguageSources(asset) {
  if (!asset.source.includes('{language}')) return;
  if (!asset.tree || !Array.isArray(asset.languages) || !asset.languages.length) {
    throw new Error(`${asset.id} source template requires languages and a tree`);
  }

  const languages = new Set(asset.languages);
  if (languages.size !== asset.languages.length) throw new Error(`${asset.id} has duplicate languages`);
  for (const language of languages) {
    verifySource(asset.source.replaceAll('{language}', language), `${asset.id}/${language}`);
  }

  const expectedPaths = new Set([...languages].map(
    language => `${asset.tree.path}/${language}.traineddata.gz`,
  ));
  const treePaths = walkFiles(resolveProjectPath(asset.tree.path))
    .map(path => normalizePath(relative(projectRoot, path)));
  if (
    treePaths.length !== expectedPaths.size
    || treePaths.some(path => !expectedPaths.has(path))
  ) {
    throw new Error(`${asset.id} languages do not match its complete tree`);
  }
}

if (manifest.schemaVersion !== 1) throw new Error('Unsupported vendor manifest schema');

for (const asset of manifest.assets) {
  if (!asset.id || !asset.version || !asset.license || !asset.source) {
    throw new Error('Every vendor asset needs id, version, license, and source');
  }
  verifySource(asset.source, asset.id);

  for (const licenseFile of asset.licenseFiles || []) {
    resolveProjectPath(licenseFile);
    lstatSync(resolveProjectPath(licenseFile));
  }
  for (const file of asset.files || []) verifyFile(file);
  if (asset.tree) verifyTree(asset.tree);
  for (const multipart of asset.multipart || []) verifyMultipart(multipart);
  verifyTreeProvenance(asset);
  verifyLanguageSources(asset);
}

for (const supportTree of manifest.supportTrees || []) verifyTree(supportTree);

const actualFiles = walkFiles(vendorRoot)
  .map(path => normalizePath(relative(projectRoot, path)))
  .filter(path => path !== 'vendor/manifest.json');

for (const path of actualFiles) {
  const bytes = lstatSync(resolveProjectPath(path)).size;
  if (bytes > manifest.maximumFileBytes) {
    throw new Error(`${path} exceeds ${manifest.maximumFileBytes} bytes`);
  }
  if (!expectedFiles.has(path)) throw new Error(`Unlisted vendor file: ${path}`);
}

for (const path of expectedFiles) {
  if (!actualFiles.includes(path)) throw new Error(`Missing vendor file: ${path}`);
}

const totalBytes = actualFiles.reduce(
  (sum, path) => sum + lstatSync(resolveProjectPath(path)).size,
  0,
);
console.log(`Verified ${actualFiles.length} vendor files (${(totalBytes / 1048576).toFixed(2)} MiB)`);
