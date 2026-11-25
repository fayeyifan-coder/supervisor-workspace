const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const Module = require('node:module');

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

async function component() {
  const file = process.env.SW_BASELINE_COMPONENT || join(__dirname, '../src/ScoreTrend.tsx');
  const { rolldown } = await import('rolldown');
  const bundle = await rolldown({ input: file, external: ['react', 'react/jsx-runtime'] });
  const generated = await bundle.generate({ format: 'cjs' });
  await bundle.close();
  const compiled = generated.output[0].code;
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(__dirname);
  m._compile(compiled, file);
  return m.exports.ScoreTrend;
}
const row = (id, fields = {}, studentId = 'student-a') => ({ id, studentId, requestId: id, revision: 1, savedAt: 1,
  fields: { assessment: id, subject: '数学', category: '日常测验', maximum: '100', score: '80', takenOn: '2026-11-25', notes: '', ...fields } });
const trend = (...args) => require('../src/score-trend.ts').scoreTrend(...args);

test('mixed full marks and categories form one subject trend by default', async () => {
  const records = [row('a'), row('b', { category: '期中考试' }), row('c', { maximum: '150', score: '120' }),
    row('d', { category: '期末考试', maximum: '120', score: '90' })];
  const html = renderToStaticMarkup(React.createElement(await component(), { records, studentId: 'student-a' }));
  assert.equal((html.match(/<li[ >]/g) || []).length, 4, 'all four same-subject exams must remain in the default trend');
  assert.match(html, /全部类别/);
  assert.match(html, /满分不同/);
});

test('all four category and maximum combinations retain raw values and ratios', () => {
  for (const fields of [{}, { category: '期中考试' }, { maximum: '150', score: '120' },
    { category: '期末考试', maximum: '150', score: '120' }]) {
    const records = [row('a'), row('b', fields)];
    const view = trend(records, 'student-a');
    assert.equal(view.points.length, 2);
    assert.equal(view.points[1].record.fields.maximum, fields.maximum || '100');
    assert.equal(view.points[1].rate, 80);
    assert.equal(view.rawAvailable, !fields.maximum);
  }
});

test('exam date orders backfills, month and year boundaries, and retains same-day exams', () => {
  const records = [row('late', { takenOn: '2026-02-01' }), row('same-b', { takenOn: '2026-01-31' }),
    row('old', { takenOn: '2025-12-31' }), row('same-a', { takenOn: '2026-01-31' }), row('new-year', { takenOn: '2026-01-01' })];
  const view = trend(records, 'student-a');
  assert.deepEqual(view.points.map(p => p.record.id), ['old', 'new-year', 'same-a', 'same-b', 'late']);
});

test('student and subject isolation, optional category, stable subject default', () => {
  const records = [row('english', { subject: '英语' }), row('math'), row('mid', { category: '期中考试' }), row('foreign', {}, 'student-b')];
  const view = trend(records, 'student-a');
  assert.equal(view.subject, '数学');
  assert.deepEqual(view.points.map(p => p.record.id), ['math', 'mid']);
  assert.deepEqual(trend(records, 'student-a', '数学', '期中考试').points.map(p => p.record.id), ['mid']);
  assert.deepEqual(trend(records, 'student-a', '英语').points.map(p => p.record.id), ['english']);
  assert.deepEqual(trend(records, 'student-b').points.map(p => p.record.id), ['foreign']);
  assert.equal(trend([...records].reverse(), 'student-a').subject, view.subject);
});

test('missing, malformed and boundary fields do not become fabricated zeros', () => {
  const records = [row('zero', { score: '0', maximum: '0.01' }), row('limit', { score: '99999.99', maximum: '99999.99' })];
  const bad = [{ score: '' }, { maximum: '0' }, { score: '-1' }, { score: '101' }, { score: 'NaN' },
    { score: '1e1' }, { score: '1.234' }, { maximum: 'Infinity' }, { takenOn: '2026-02-30' },
    { takenOn: '2026-11-25T00:00:00Z' }, { subject: '' }, { maximum: '100000' }];
  bad.forEach((f, i) => records.push(row('bad-' + i, f)));
  const view = trend(records, 'student-a');
  assert.equal(view.invalidCount, bad.length);
  assert.deepEqual(view.points.map(p => p.rate), [100, 0]);
  assert.equal(trend([], 'student-a').points.length, 0);
});

test('changed input refreshes edits and removed records without mutating source rows', () => {
  const original = [row('a'), row('b', { score: '90' })];
  const snapshot = JSON.stringify(original);
  assert.equal(trend(original, 'student-a').points.length, 2);
  const edited = [original[0], { ...original[1], fields: { ...original[1].fields, score: '95.5' } }];
  assert.equal(trend(edited, 'student-a').points[1].rate, 95.5);
  assert.equal(trend(edited.slice(0, 1), 'student-a').points.length, 1);
  assert.equal(trend([], 'student-a').points.length, 0);
  assert.equal(JSON.stringify(original), snapshot);
});

test('raw scores require equal maxima across the full filtered history, not only the last 12', () => {
  const records = Array.from({ length: 13 }, (_, i) => row('record-' + i, { takenOn: '2026-11-' + String(i + 1).padStart(2, '0'),
    maximum: i === 0 ? '150' : '100' }));
  const view = trend(records, 'student-a');
  assert.equal(view.points.length, 12);
  assert.equal(view.total, 13);
  assert.equal(view.rawAvailable, false);
  assert.equal(trend(records.slice(1), 'student-a').rawAvailable, true);
});

test('empty and single-record views explain why no comparison is available', async () => {
  const ScoreTrend = await component();
  const empty = renderToStaticMarkup(React.createElement(ScoreTrend, { records: [], studentId: 'student-a' }));
  const single = renderToStaticMarkup(React.createElement(ScoreTrend, { records: [row('one')], studentId: 'student-a' }));
  assert.match(empty, /暂无可用成绩/);
  assert.match(single, /仅有 1 条/);
});

test('backup import preserves manual score identities, raw strings and computed trends', async t => {
  const { mkdtempSync, rmSync, realpathSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { randomUUID } = require('node:crypto');
  const { WorkspaceDatabase } = require('../build/database.js');
  const { WorkLogDatabase } = require('../build/worklog.js');
  const { GrowthProfileDatabase } = require('../build/growth-profile.js');
  const { IntakeStore } = require('../build/student-intake.js');
  const { OperationsDatabase } = require('../build/operations.js');
  const { ProtectionFiles, captureProtection } = require('../build/offline-protection.js');
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'sw-score-trend-'));
  const stores = [];
  t.after(() => { for (const store of stores.reverse()) store.close(); rmSync(root, { recursive: true, force: true }); });
  const m1 = WorkspaceDatabase.open(join(root, 'mvp.sqlite3'), join(root, 'mvp.initialized'), 6); stores.push(m1);
  const studentId = randomUUID(); m1.createStudent({ id: studentId, alias: '虚构趋势备份', grade: '七年级', subjects: '数学', goal: '', notes: '' });
  stores.push(WorkLogDatabase.open(join(root, 'worklog.sqlite3'), join(root, 'worklog.initialized')),
    GrowthProfileDatabase.open(join(root, 'growth.sqlite3'), join(root, 'growth.initialized')),
    IntakeStore.open(join(root, 'student-intake.sqlite3'), join(root, 'student-intake.initialized')));
  stores.push(OperationsDatabase.open(root, m1, true));
  for (const [category, maximum, score] of [['日常测验', '100', '70'], ['期中考试', '150.50', '90.25']]) {
    m1.saveStudentRecord({ kind: 'score', id: randomUUID(), requestId: randomUUID(), studentId, expectedRevision: 0,
      fields: { assessment: '合成备份对比', takenOn: '2026-11-25', category, maximum, score, subject: '数学', notes: '' } });
  }
  const before = m1.studentRecords('score', studentId).records;
  const bytes = captureProtection(stores, '0.2.0', 2, 6), original = Buffer.from(bytes);
  const io = new ProtectionFiles(join(__dirname, '../build/recovery-io.exe'));
  const restored = await io.restore(root, bytes, true);
  const copy = WorkspaceDatabase.open(join(restored.location, 'data', 'mvp.sqlite3'), join(restored.location, 'data', 'mvp.initialized'), 6);
  stores.push(copy);
  const imported = copy.studentRecords('score', studentId).records;
  assert.deepEqual(imported, before);
  assert.deepEqual(trend(imported, studentId), trend(before, studentId));
  assert.deepEqual(bytes, original);
});


