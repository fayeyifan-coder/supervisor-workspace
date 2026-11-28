const JSZip=require('jszip');
const p=t=>'<w:p><w:r><w:t>'+t+'</w:t></w:r></w:p>';
const tc=(t,attributes='')=>'<w:tc><w:tcPr>'+attributes+'</w:tcPr>'+p(t)+'</w:tc>';
const row=(...cells)=>'<w:tr>'+cells.join('')+'</w:tr>';
const table=(...rows)=>'<w:tbl>'+rows.join('')+'</w:tbl>';
async function studyPlanDocx(index=1,conflict=false){
 const zip=new JSZip();
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 const intro=p('合成半年学习规划 '+index)+p('学生姓名：虚构甲')+p('年级：合成七年级')+p('学年学期：合成学年上学期')+
   p('学科：数学、英语')+p('规划依据：合成薄弱项')+p('学习习惯：合成审题清单')+
   table(row(tc('姓名','<w:vMerge w:val="restart"/>'),tc(conflict?'虚构乙':'虚构甲')),row(tc('','<w:vMerge/>'),tc('合成未知备注')));
 const tasks=table(row(tc('12月份学习目标','<w:gridSpan w:val="6"/>')),
   row(tc('学习内容'),...[1,2,3,4,5].map(i=>tc('第'+i+'周'))),
   row(tc('数学'),...[1,2,3,4,5].map(i=>tc('合成任务 '+i))),
   row(tc('预计学习时间'),tc('90 分钟'),tc('2 小时'),tc(''),tc('90 分钟'),tc('45 分钟')),
   row(tc('1月份学习目标'),tc('合成复习目标')),
   row(tc('学习内容'),tc('第一周')),row(tc('英语'),tc('合成阅读任务')));
 zip.file('word/document.xml','<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+intro+tasks+'<w:sectPr/></w:body></w:document>');
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
module.exports={studyPlanDocx};
