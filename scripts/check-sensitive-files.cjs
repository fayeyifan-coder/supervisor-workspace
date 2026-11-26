// Dependency-free, content-based guard. Never prints matched content or private filenames.
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const privatePath = /(^|\/)(?:profiles?|backups?|imports?|exports?|attachments?|private-data|work|outputs|release|dist|build|node_modules)(?:\/|$)/i;
const forbiddenExtension = /\.(?:sqlite(?:3)?(?:-(?:wal|shm|journal))?|db(?:-(?:wal|shm|journal))?|swbackup|swback|docx?|xlsx?|xlsm|csv|pdf|zip|7z|tar|gz|pem|p12|pfx|key)$/i;
const mediaExtension = /\.(?:png|jpe?g|webp|gif|bmp|svg|json)$/i;
const configJson = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.main.json', 'test/fixtures/manifest.json']);
const rules = [
 ['CREDENTIAL', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g],
 ['CREDENTIAL_ASSIGNMENT', /(?:api[_-]?key|access[_-]?token|password|passwd|client[_-]?secret)\s*[=:]\s*["']([^"'\r\n]{8,})["']/gi],
 ['URL_CREDENTIAL', /https?:\/\/[^\s/:@]+:[^\s/@]+@/gi],
 ['PERSONAL_PATH', /[A-Z]:[\\/]+Users[\\/]+(?!runneradmin\b|runner\b|Public\b|Default\b|<|\$|%)[^\\/\s"'<>:]{2,}/gi],
 ['PERSONAL_CONTACT', /(?<![A-Za-z0-9])1[3-9]\d{9}(?![A-Za-z0-9])/g],
 ['IDENTITY_NUMBER', /(?<![A-Za-z0-9])\d{17}[0-9Xx](?![A-Za-z0-9])/g],
];
function validEntry(entry) {
 return entry && /^[0-9a-f]{64}$/.test(entry.sha256) &&
  ['synthetic-json', 'synthetic-image'].includes(entry.kind) &&
  typeof entry.purpose === 'string' && entry.purpose.length > 10 &&
  typeof entry.provenance === 'string' && entry.provenance.length > 20 &&
  entry.realStudentData === false && entry.reviewed === true;
}
function inspect(name, bytes, manifest = {}, mode = '100644') {
 const found = [];
 const add = (rule, line = 1) => found.push({ rule, fileId: sha(name).slice(0, 16), line });
 const normalized = name.replaceAll('\\', '/');
 if (mode === '120000' || mode === '160000') add('EXTERNAL_REFERENCE');
 if (privatePath.test(normalized) || /(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials(?:\..*)?)$/i.test(normalized)) add('PRIVATE_PATH_OR_FILE');
 if (forbiddenExtension.test(normalized)) add('PRIVATE_FILE_TYPE');
 if (bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) || bytes.subarray(0, 8).equals(Buffer.from('SWBACK2\n')) || bytes.subarray(0, 8).equals(Buffer.from('SWBACK1\n')) || bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) add('PRIVATE_CONTAINER_MAGIC');
 const entry = manifest.entries?.[normalized];
 const needsReview = mediaExtension.test(normalized) && !configJson.has(normalized);
 if (needsReview && (!validEntry(entry) || entry.sha256 !== sha(bytes))) add('UNREVIEWED_FIXTURE');
 const binary = bytes.subarray(0, 8192).includes(0);
 if (binary && !(needsReview && validEntry(entry) && entry.sha256 === sha(bytes))) add('UNREVIEWED_BINARY');
 if (!binary) {
  const text = bytes.toString('utf8');
  for (const [rule, regex] of rules) {
   regex.lastIndex = 0;
   for (const match of text.matchAll(regex)) add(rule, text.slice(0, match.index).split('\n').length);
  }
  if (/^version https:\/\/git-lfs.github.com\/spec\/v1/m.test(text)) add('UNINSPECTED_LFS_OBJECT');
 }
 return found;
}
function run(argv = process.argv.slice(2), cwd = process.cwd()) {
 const git = args => execFileSync('git', ['--no-optional-locks', ...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
 const mode = argv[0] || '--staged';
 if (!['--staged', '--tracked', '--history'].includes(mode)) throw Error('Use --staged, --tracked or --history <revision-range>');
 const getManifest = tree => {
  try { return JSON.parse(git(['show', tree + ':test/fixtures/manifest.json']).toString('utf8')); }
  catch { return { entries: {} }; }
 };
 const snapshots = [];
 if (mode === '--history') {
  if (!argv[1]) throw Error('An explicit revision range is required');
  const commits = git(['rev-list', '--reverse', argv[1], '--']).toString('utf8').trim().split('\n').filter(Boolean);
  for (const commit of commits) snapshots.push({ tree: commit, entries: git(['ls-tree', '-rz', commit]).toString('utf8').split('\0').filter(Boolean) });
 } else {
  const selected = mode === '--staged' ? new Set(git(['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z']).toString('utf8').split('\0').filter(Boolean)) : null;
  snapshots.push({ tree: '', entries: git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).filter(row => !selected || selected.has(row.slice(row.indexOf('\t') + 1))) });
 }
 const findings = []; const cache = new Map(); let checked = 0;
 // Batch Git object reads: avoid one process per source file on Windows.
 const ids = [...new Set(snapshots.flatMap(s => s.entries.map(row => {
  const fields = row.slice(0, row.indexOf('\t')).split(' '); return s.tree ? fields[2] : fields[1];
 })))];
 const objectInfo = new Map();
 if (ids.length) {
  const metadata = execFileSync('git', ['--no-optional-locks','cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'], {cwd,input:ids.join('\n')+'\n',maxBuffer:64*1024*1024}).toString('utf8').trim().split('\n');
  for (const line of metadata) { const [oid,type,size] = line.split(' '); objectInfo.set(oid,{type,size:Number(size)}); }
  const small = ids.filter(oid => objectInfo.get(oid)?.type === 'blob' && objectInfo.get(oid).size <= 5*1024*1024);
  if (small.length) {
   const packed = execFileSync('git',['--no-optional-locks','cat-file','--batch'],{cwd,input:small.join('\n')+'\n',maxBuffer:64*1024*1024});
   let cursor=0;
   while(cursor<packed.length){const end=packed.indexOf(10,cursor);if(end<0)throw Error('Incomplete object header');const [oid,type,length]=packed.subarray(cursor,end).toString('ascii').split(' ');const size=Number(length);if(type!=='blob'||!Number.isSafeInteger(size)||end+1+size>=packed.length)throw Error('Incomplete object');cache.set(oid,packed.subarray(end+1,end+1+size));cursor=end+size+2;}
  }
 }
 for (const snapshot of snapshots) {
  // Each revision uses its own manifest; later approvals cannot hide an earlier leak.
  const manifest = getManifest(snapshot.tree);
  for (const row of snapshot.entries) {
   const tab = row.indexOf('\t'); const name = row.slice(tab + 1); const fields = row.slice(0, tab).split(' ');
   const [fileMode, objectKindOrId, idOrStage] = fields;
   const oid = snapshot.tree ? idOrStage : objectKindOrId;
   if (!snapshot.tree && idOrStage !== '0') { findings.push({ rule: 'UNMERGED_INDEX', fileId: sha(name).slice(0, 16), line: 1 }); continue; }
   const info = objectInfo.get(oid);
   if (!info || !Number.isFinite(info.size)) throw Error('Unavailable object');
   const size = info.size;
   if (size > 5 * 1024 * 1024) { findings.push({ rule: 'UNREVIEWED_LARGE_FILE', fileId: sha(name).slice(0, 16), line: 1 }); continue; }
   if (info.type !== 'blob') { findings.push({rule:'EXTERNAL_REFERENCE',fileId:sha(name).slice(0,16),line:1});continue; }
   if (!cache.has(oid)) throw Error('Missing object bytes');
   checked++;
   for (const finding of inspect(name, cache.get(oid), manifest, fileMode)) findings.push({ ...finding, ...(snapshot.tree ? { commit: snapshot.tree } : {}) });
  }
 }
 return { mode, checked, findings };
}
if (require.main === module) {
 try { const result = run(); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.findings.length ? 1 : 0; }
 catch { process.stderr.write('Privacy scan failed closed; inspect the repository locally. No matched contents logged.\n'); process.exitCode = 2; }
}
module.exports = { inspect, run, validEntry, sha };
