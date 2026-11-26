const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const yaml=require('js-yaml');
const workflow=name=>yaml.load(fs.readFileSync(path.join(__dirname,'../.github/workflows',name),'utf8'));
test('ordinary Windows validation retains engineering gates without artifact storage dependency',()=>{
 const w=workflow('windows.yml'),steps=w.jobs.windows.steps;
 for(const name of ['Type check','Test database','Build desktop application','Package and verify the MVP desktop preview','Smoke-test packaged Electron on an isolated profile'])assert(steps.some(s=>s.name===name),name);
 assert(!steps.some(s=>s.uses?.startsWith('actions/upload-artifact')));assert(steps.every(s=>s['continue-on-error']!==true));assert.equal(w.permissions.contents,'read');
});
test('candidate upload is manually requested, pinned, independently named and fails closed',()=>{
 const w=workflow('release-candidate.yml');assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);assert(w.on.workflow_dispatch.inputs.source_sha.required);assert(w.on.workflow_dispatch.inputs.version.required);
 const steps=w.jobs['candidate-artifact-windows'].steps;assert(steps.some(s=>s.run?.includes('Build-ControlledCandidate.ps1')));const upload=steps.find(s=>s.uses?.startsWith('actions/upload-artifact'));assert(upload);assert.equal(upload.with['if-no-files-found'],'error');assert(!upload['continue-on-error']);assert.equal(w.permissions.contents,'read');assert(steps.every(s=>!s.run?.includes('gh release')));
});
