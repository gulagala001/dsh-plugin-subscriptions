// Run after a clean build and targeted tests; never publishes to npm.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const output = resolve(process.argv[2] || '.release');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.name, 'dsh-plugin-subscriptions');
assert.equal(pkg.license, 'MIT');
assert.equal(pkg.repository.url, 'git+https://github.com/V1ki/dsh-plugin-subscriptions.git');
assert.match(pkg.version, /^\d+\.\d+\.\d+-omd\.\d+$/);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Commit tracked source changes before packaging');
mkdirSync(output, { recursive: true });
const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { encoding: 'utf8' }))[0];
const archive = resolve(output, packed.filename);
const files = new Set(packed.files.map(file => file.path));
for (const path of ['package.json', 'LICENSE', 'cordis.patch.yml', 'lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/client/index.d.ts']) {
  assert.ok(files.has(path), `Missing package entry: ${path}`);
}
for (const path of files) assert.ok(!/^(?:test|scripts|\.github|node_modules|lib-test)\//.test(path), `Unexpected development file: ${path}`);
const tarEntry = name => execFileSync('tar', ['-xOf', archive, `package/${name}`], { encoding: 'utf8' });
assert.deepEqual(JSON.parse(tarEntry('package.json')), pkg);
assert.match(tarEntry('LICENSE'), /Copyright \(c\) 2026 V1ki/);
assert.match(tarEntry('lib/client.js'), /id: "dsh-plugin-subscriptions"/);
assert.equal(tarEntry('cordis.patch.yml'), readFileSync('cordis.patch.yml', 'utf8'));
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
const sourceCommit = git('rev-parse', 'HEAD');
const metadata = {
  schemaVersion: 1,
  name: pkg.name,
  version: pkg.version,
  tag: `v${pkg.version}`,
  filename: packed.filename,
  sha256,
  sourceCommit,
  sourceTree: git('rev-parse', 'HEAD^{tree}'),
  distributionRepository: 'gulagala001/dsh-plugin-subscriptions',
  sourceUrl: `https://github.com/gulagala001/dsh-plugin-subscriptions/tree/${sourceCommit}`,
  upstreamRepository: 'V1ki/dsh-plugin-subscriptions',
  license: pkg.license,
  npmPublished: false,
  validationScope: 'Build, 9 targeted offline unit/RPC/command tests, 9 React/Chromium Fast race/failure tests and package checks. See docs/omd-release.md for native lifecycle evidence and unverified provider behavior.',
};
writeFileSync(resolve(output, `${pkg.name}-${pkg.version}.metadata.json`), JSON.stringify(metadata, null, 2) + '\n');
writeFileSync(resolve(output, 'SHA256SUMS'), `${sha256}  ${packed.filename}\n`);
console.log(JSON.stringify(metadata, null, 2));
