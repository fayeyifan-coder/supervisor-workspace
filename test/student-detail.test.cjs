const assert = require('node:assert/strict');
const { test } = require('node:test');
const { join } = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
async function render(options = {}) {
  const { rolldown } = await import('rolldown');
  const file = process.env.SW_BASELINE_DETAIL || join(__dirname, '../src/StudentDetail.tsx');
  const bundle = await rolldown({ input: file, external: id => id === 'react' || id.startsWith('react/') || id.endsWith('.css') });
  const generated = await bundle.generate({ format: 'cjs' }); await bundle.close();
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(__dirname);
  const original = m.require.bind(m); m.require = id => id.endsWith('.css') ? {} : original(id);
  m._compile(generated.output[0].code, file);
  return renderToStaticMarkup(React.createElement(m.exports.StudentDetail, {
    student: { id: 'synthetic-a', alias: '虚构甲', grade: '七年级', subjects: '数学', goal: '既有目标', notes: '' },
    api: {}, intakeOpen: false, actions: React.createElement('button', null, '查看该学生排课'),
    growth: '成长内容', history: '学习历史内容', parentFollowUp: '家长诉求内容', edit: '基础编辑内容',
    recordPanels: ['enrollment', 'score', 'improvement'].map(id => ({ id, label: id, content: id + '内容' })), ...options,
  }));
}
const nav = html => html.match(/<nav[^>]*aria-label="学生详情"[^>]*>(.*?)<\/nav>/s)[1];
test('profile navigation prioritizes concerns and scores with history and sources last', async () => {
  const html = await render();
  const labels = [...nav(html).matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(m => m[1]);
  assert.deepEqual(labels, ['家长诉求','成绩趋势','成长档案','提分方案','报名与到期','基础档案编辑','学习历史','导入来源']);
  assert.match(nav(html), /aria-controls="student-section-parent" aria-pressed="true"/);
  assert.match(html, /查看该学生排课/); assert.match(html, /既有目标/);
});
test('legacy capability fallbacks expose only enabled modules', async () => {
  for (const [recordPanels, edit, expected] of [[[], undefined, ['成长档案','学习历史','导入来源']],
    [[{id:'enrollment',label:'报名与到期',content:'报名'}], '编辑', ['成长档案','报名与到期','基础档案编辑','学习历史','导入来源']],
    [[{id:'score',label:'成绩趋势',content:'成绩'}], '编辑', ['成绩趋势','成长档案','基础档案编辑','学习历史','导入来源']]]) {
    const html = await render({ parentFollowUp: undefined, recordPanels, edit });
    assert.deepEqual([...nav(html).matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(m=>m[1]),expected);
    assert(!nav(html).includes('后续功能'));
  }
});
test('all existing panels stay mounted while inactive, preserving their drafts', async () => {
  const html = await render();
  for (const id of ['growth','history','sources','edit','score','improvement','enrollment']) assert.match(html,new RegExp('id="student-section-'+id+'" hidden=""'));
  assert.match(html,/成长内容/);assert.match(html,/学习历史内容/);assert.match(html,/基础编辑内容/);
});
