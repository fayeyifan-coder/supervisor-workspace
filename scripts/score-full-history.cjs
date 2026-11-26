// Exercises the actual packaged renderer, never injects development components.
const assert=require('node:assert/strict');const{randomUUID}=require('node:crypto');
module.exports=async function(ui,capture){
 const api=(name,...args)=>ui('window.supervisorWorkspace['+JSON.stringify(name)+'](...'+JSON.stringify(args)+')');
 const ok=r=>{assert(r.ok,JSON.stringify(r));return r.value;};
 const students=ok(await api('students')),a=students.find(s=>s.alias==='虚构验收甲'),b=students.find(s=>s.alias==='虚构验收乙');assert(a&&b);
 for(let i=0;i<65;i++){const requestId=randomUUID();ok(await api('saveStudentRecord',{kind:'score',studentId:a.id,id:randomUUID(),requestId,expectedRevision:0,fields:{assessment:'完整历史'+String(i+1).padStart(3,'0'),subject:'数学',takenOn:new Date(Date.UTC(2024,0,i+1)).toISOString().slice(0,10),category:i%2?'期中考试':'日常测验',score:i%2?'120':String(80+i%10),maximum:i%2?'150':'100',notes:'合成'}}));ok(await api('resolveStudentWrite','confirm',requestId));}
 const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw Error('Full history UI timeout');};
 const choose=alias=>ui('Array.from(document.querySelectorAll("aside button")).find(b=>b.textContent.includes('+JSON.stringify(alias)+')).click();true');
 const click=label=>ui('Array.from(document.querySelectorAll("#student-section-score button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click();true');
 const scope='document.querySelector("#student-section-score .score-trend")';
 const pointCount=()=>ui(scope+'.querySelector("canvas")?.dataset.pointCount');
 const change=async(selector,value)=>{await ui('(()=>{const x='+scope+'.querySelector('+JSON.stringify(selector)+');const proto=x.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(x,'+JSON.stringify(value)+');x.dispatchEvent(new Event(x.tagName==="SELECT"?"change":"input",{bubbles:true}));return true;})()');await new Promise(r=>setTimeout(r,80));};
 const toggle=async selector=>{await ui(scope+'.querySelector('+JSON.stringify(selector)+').click();true');await new Promise(r=>setTimeout(r,80));};
 await choose(b.alias);await new Promise(r=>setTimeout(r,100));await choose(a.alias);await new Promise(r=>setTimeout(r,100));await ui('Array.from(document.querySelectorAll(".student-detail-nav button")).find(b=>b.textContent==="成绩趋势").click();true');
 const before=ok(await api('studentRecords','score',a.id));assert.equal(before.records.filter(r=>r.fields.subject==='数学').length,71);
 await wait(async()=>await pointCount()==='71');assert.equal(await ui(scope+'.querySelectorAll(".score-trend-points li").length'),50);
 await click('下一页');await wait(()=>ui(scope+'.querySelectorAll(".score-trend-points li").length===21'));assert.equal(await pointCount(),'71');
 await change('input[aria-label="开始日期"]','2024-01-01');await change('input[aria-label="结束日期"]','2024-01-03');assert.equal(await pointCount(),'3');
 await change('select:nth-of-type(1)','数学'); // First select belongs to the subject label.
 await ui('(()=>{const x='+scope+'.querySelectorAll("select")[1];x.value="日常测验";x.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');await wait(async()=>await pointCount()==='2');
 await toggle('.score-compare-toggle input');await toggle('input[aria-label="对比 完整历史001"]');await toggle('input[aria-label="对比 完整历史003"]');assert.equal(await pointCount(),'2');assert(await ui('!'+scope+'.querySelector("option[value=raw]").disabled'));
 const checkboxLayout=await ui('Array.from('+scope+'.querySelectorAll("input[type=checkbox]")).map(x=>{const r=x.getBoundingClientRect(),s=getComputedStyle(x.parentElement);return{width:r.width,height:r.height,display:s.display,whiteSpace:s.whiteSpace};})');
 // A flex item blockifies inline-flex to flex in computed style.
 assert(checkboxLayout.every(x=>x.width===16&&x.height===16&&['flex','inline-flex'].includes(x.display)&&x.whiteSpace==='nowrap'),JSON.stringify(checkboxLayout));
 if(capture)await capture('custom-comparison-candidate.png');
 assert.deepEqual(ok(await api('studentRecords','score',a.id)),before);
 await ui('Array.from(document.querySelectorAll("#student-section-score ul.student-source-list>li")).find(x=>x.querySelector("h3").textContent==="完整历史003").querySelector("button").click();true');
 await ui('(()=>{const x=document.querySelector("#student-section-score input[name=score]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"94.25");x.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#student-section-score form").requestSubmit();return true;})()');
 await wait(()=>ui(scope+'.innerText.includes("所选考试已更新")'));assert.equal(await pointCount(),'2');
 await change('input[aria-label="结束日期"]','2024-01-01');assert.equal(await pointCount(),'1');assert(await ui(scope+'.innerText.includes("已清除选择")'));
 await change('input[aria-label="开始日期"]','2024-01-04');assert(await ui(scope+'.querySelector("[role=alert]")?.textContent.includes("不能晚于")'));assert.equal(await pointCount(),undefined);
 await change('input[aria-label="开始日期"]','2024-01-01');await toggle('.score-compare-toggle input');await click('清除时间及类别筛选');await wait(async()=>await pointCount()==='71');
 assert(await ui(scope+'.querySelector("option[value=raw]").disabled'));
 const after=ok(await api('studentRecords','score',a.id));const original=before.records.find(r=>r.fields.assessment==='完整历史003'),edited=after.records.find(r=>r.id===original.id);assert.equal(edited.revision,original.revision+1);assert.equal(edited.fields.score,'94.25');assert.deepEqual(after.records.filter(r=>r.id!==original.id),before.records.filter(r=>r.id!==original.id));
 await choose(b.alias);await new Promise(r=>setTimeout(r,120));await ui('Array.from(document.querySelectorAll(".student-detail-nav button")).find(b=>b.textContent==="成绩趋势").click();true');await wait(async()=>await pointCount()==='1');assert.equal(await ui(scope+'.querySelector("input[aria-label=开始日期]").value'),'');
 await choose(a.alias);await new Promise(r=>setTimeout(r,120));await ui('Array.from(document.querySelectorAll(".student-detail-nav button")).find(b=>b.textContent==="成绩趋势").click();true');await wait(async()=>await pointCount()==='71');
 return{actualPackagedComponent:true,allExams:71,firstPage:50,secondPage:21,allPointsAcrossPages:true,inclusiveDateAndCategory:true,customComparison:true,checkboxLayout:true,selectedEditRefreshExplained:true,editedEntityId:edited.id,selectionRemovalExplained:true,invalidRangeExplained:true,mixedMaximaRawDisabled:true,filterOperationsDoNotWrite:true,studentSwitchResetsFilters:true};
};
