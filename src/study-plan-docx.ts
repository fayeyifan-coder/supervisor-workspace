import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type { SaxesParser } from "saxes";
import { documentLimit, emptyPlan, planTextLimit, type PlanDraft, type PlanEntry, type PlanSourceCell } from "./study-plan-model";
import { WorkspaceFault } from "./workspace-fault";

const namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const strictNamespace = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const partLimit = 2 * 1024 * 1024;
function invalid(message: string): never { throw new WorkspaceFault("invalid", message); }

function documentPart(input: Buffer): Buffer {
  if (input.length < 22 || input.length > documentLimit) invalid("Word 原件大小超出支持范围。");
  const end = input.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
  if (end < 0 || end+22 > input.length || end+22+input.readUInt16LE(end+20) !== input.length) {
    invalid("无法读取 DOCX 容器。");
  }
  const count=input.readUInt16LE(end+10), start=input.readUInt32LE(end+16);
  if (!count || count > 256 || input.readUInt16LE(end+4) || input.readUInt16LE(end+6) ||
    count!==input.readUInt16LE(end+8) || start+input.readUInt32LE(end+12)!==end) invalid("DOCX 目录结构不受支持。");
  let cursor=start, document: Buffer | undefined, types=false;
  for(let i=0;i<count;i++){
    if(cursor+46>end || input.readUInt32LE(cursor)!==0x02014b50) invalid("DOCX 目录不完整。");
    const length=input.readUInt16LE(cursor+28);
    const next=cursor+46+length+input.readUInt16LE(cursor+30)+input.readUInt16LE(cursor+32);
    if(next>end)invalid("DOCX 目录不完整。");
    const name=input.toString("utf8",cursor+46,cursor+46+length);
    if(name==="[Content_Types].xml")types=true;
    if(/(?:vbaProject|activeX)/i.test(name))invalid("不支持包含宏或活动控件的 Word 文档。");
    if(name==="word/document.xml"){
      const offset=input.readUInt32LE(cursor+42), packed=input.readUInt32LE(cursor+20), size=input.readUInt32LE(cursor+24);
      const method=input.readUInt16LE(cursor+10), flags=input.readUInt16LE(cursor+8);
      if(document || size>partLimit || (flags&1) || offset+30>start || input.readUInt32LE(offset)!==0x04034b50 ||
        input.readUInt16LE(offset+8)!==method || ![0,8].includes(method))invalid("DOCX 正文压缩方式无效。");
      const source=offset+30+input.readUInt16LE(offset+26)+input.readUInt16LE(offset+28);
      if(source+packed>start || input.toString("utf8",offset+30,offset+30+input.readUInt16LE(offset+26))!==name)invalid("DOCX 正文边界无效。");
      const part=input.subarray(source,source+packed);
      try{document=method===0?part:inflateRawSync(part,{maxOutputLength:partLimit});}
      catch{invalid("无法安全解压 DOCX 正文。");}
      if(document.length!==size)invalid("DOCX 正文长度不一致。");
    }
    cursor=next;
  }
  if(cursor!==end || !types || !document)invalid("缺少有效的 DOCX 正文。");
  return document;
}

interface Extracted { cells: PlanSourceCell[]; paragraphs: PlanSourceCell[]; tables: PlanSourceCell[][][]; notes: Set<string> }
function readDocument(document: Buffer): Extracted {
  const Runtime=require("./saxes.runtime.js") as { SaxesParser: typeof SaxesParser };
  const parser=new Runtime.SaxesParser({xmlns:true});
  const result: Extracted={cells:[],paragraphs:[],tables:[],notes:new Set()};
  const stack:string[]=[];
  const tableStack: {number:number; rows:PlanSourceCell[][]; row?:PlanSourceCell[]; cell?:PlanSourceCell; column:number}[]=[];
  const paragraphStack: {depth:number;text:string;cell?:PlanSourceCell}[]=[];
  let body=false, paragraph=0, total=0;
  parser.on("doctype",()=>invalid("不支持包含 XML 文档类型声明的原件。"));
  parser.on("error",()=>invalid("DOCX 正文 XML 无效。"));
  parser.on("opentag", tag => {
    const name=tag.uri===namespace||tag.uri===strictNamespace?tag.local:"";
    stack.push(name);
    if(stack.length>160)invalid("正文嵌套超过解析上限。");
    if(name==="body")body=true;
    if(!body)return;
    let table=tableStack.at(-1);
    const val=Object.values(tag.attributes).find(a=>a.local==="val"&&(a.uri===namespace||a.uri===strictNamespace))?.value;
    if(name==="tbl"){
      const rows:PlanSourceCell[][]=[];
      result.tables.push(rows);table={number:result.tables.length,rows,column:1};tableStack.push(table);
      if(tableStack.length>1)result.notes.add("包含嵌套表格，未归类的单元格保留在原文核对区。");
    } else if(name==="tr"&&table){
      table.row=[];table.rows.push(table.row);table.column=1;
    } else if(name==="tc"&&table?.row){
      table.cell={ref:"t"+table.number+":r"+table.rows.length+":c"+table.column,text:""};
      table.row.push(table.cell); result.cells.push(table.cell);
    } else if(name==="gridSpan"&&table?.cell){
      const span=Number(val);
      if(!Number.isInteger(span)||span<1||span>128)invalid("DOCX 合并单元格跨度无效。");
      table.cell.span=span;
    } else if(name==="vMerge"&&table?.cell){table.cell.merge=val==="restart"?"start":"continue";}
    else if(name==="p"){paragraphStack.push({depth:stack.length,text:"",cell:table?.cell});}
    else if(["drawing","pict","object","ins","del","footnoteReference","endnoteReference","sdt","instrText","altChunk"].includes(name)){
      result.notes.add("图像、字段、修订或特殊内容需对照原件，全文原件会保留。");
    } else if(name==="tab"||name==="br"||name==="cr"){
      const current=paragraphStack.at(-1);if(current)current.text+=name==="tab"?"\t":"\n";
    }
  });
  parser.on("text",text=>{
    const current=paragraphStack.at(-1);
    if(body&&current&&stack.at(-1)==="t"){current.text+=text;total+=text.length;if(total>planTextLimit)invalid("正文文本超过解析上限。");}
  });
  parser.on("closetag",()=>{
    const name=stack.at(-1),current=paragraphStack.at(-1), table=tableStack.at(-1);
    if(name==="p"&&current?.depth===stack.length){
      paragraphStack.pop();
      if(current.cell){current.cell.text+=(current.cell.text?"\n":"")+current.text;}
      else {
        paragraph++;
        if(current.text.trim()){
          const line={ref:"p"+paragraph,text:current.text};
          result.paragraphs.push(line);result.cells.push(line);
        }
      }
    } else if(name==="tc"&&table?.cell){table.column+=table.cell.span??1;table.cell=undefined;}
    else if(name==="tbl")tableStack.pop();
    else if(name==="body")body=false;
    if(result.cells.length>2000)invalid("正文段落和单元格过多，请拆分文档。");
    stack.pop();
  });
  let xml: string;
  try{xml=new TextDecoder("utf-8",{fatal:true}).decode(document);}
  catch{invalid("DOCX 正文编码无法读取，请用 Word 另存为 DOCX。");}
  parser.write(xml).close();
  if(!result.cells.some(cell=>cell.text.trim()))invalid("未找到可解析的正文，请用人工处理入口。");
  return result;
}

const monthPattern=/(?<!\d)((?:20\d{2}\s*年\s*)?(?:1[0-2]|0?[1-9]|十[一二]?|[一二三四五六七八九])\s*月)/u;
const weekPattern=/^(?:第\s*[一二三四五六七八九十\d]+\s*周|周次\s*[一二三四五六七八九十\d]+)$/u;
const subjects="语文 数学 英语 物理 化学 生物 科学 道德与法治 历史 地理 政治 信息技术".split(" ");
function cellColumn(cell:PlanSourceCell){return Number(/:c(\d+)$/.exec(cell.ref)?.[1]);}
function coveringHeader(headers:PlanSourceCell[],cell:PlanSourceCell){
  const from=cellColumn(cell), end=from+(cell.span??1);
  return headers.find(header=>cellColumn(header)<=from&&end<=cellColumn(header)+(header.span??1));
}
function meaningful(line:string){return line.trim().replace(/^(?:[\d一二三四五六七八九十]+[、.．)）]\s*)/u,"");}
function fieldType(text:string){
  if(/学情|学习现状|学习情况|规划依据|学科现状|性格|目前成绩/.test(text))return "context";
  if(/目标|预期效果/.test(text))return "goals";
  if(/习惯|措施|干预|学习过程要求|课堂要求/.test(text))return "habits";
  if(/备注/.test(text))return "notes";
}
export function parseStudyPlan(input:Buffer): {fields:PlanDraft;cells:PlanSourceCell[];warnings:string[]} {
  const raw=readDocument(documentPart(input)), fields=emptyPlan();
  const warnings=raw.notes;
  const labels={learner:new Set<string>(),grade:new Set<string>()};
  const add=(entry:Omit<PlanEntry,"id"|"from"|"to">)=>fields.entries.push({...entry,id:randomUUID(),from:"",to:""});
  function identity(label:string,value:string){
    if(!value.trim())return;
    if(/^(?:学生)?姓名$|^学生名$/.test(label))labels.learner.add(value.trim());
    if(/^(?:就读)?年级$/.test(label))labels.grade.add(value.trim());
    if(/^(?:规划|学习|辅导|所学|目标|主要|培训)?(?:学科|科目)$/.test(label)){
      const names=subjects.filter(subject=>value.includes(subject));
      fields.subjects=[...new Set([...fields.subjects,...(names.length?names:[value.trim()])])];
    }
    if(/^(?:规划|学习)?周期$|^(?:学年)?学期$/.test(label))fields.term ||= value.trim();
  }
  for(const line of raw.paragraphs){
    const text=meaningful(line.text), split=/^([^：:\n]{1,12})[：:]\s*(.*)$/s.exec(text);
    if(split){
      identity(split[1].trim(),split[2]);
      const field=fieldType(split[1]);
      if(field&&split[2].trim())fields[field]+=(fields[field]?"\n":"")+split[2].trim();
    }
    if(!fields.title&&/规划|计划|辅导方案/.test(text)&&!split)fields.title=text;
    if(!fields.term&&/学期|学年/.test(text)&&text.length<70)fields.term=text;
  }
  for(const rows of raw.tables){
    const first=raw.cells.indexOf(rows[0]?.[0]);
    const heading=raw.cells.slice(0,Math.max(0,first)).reverse().find(cell=>/^p\d+$/.test(cell.ref));
    const precedingMonth=heading&&monthPattern.exec(meaningful(heading.text));
    let month=precedingMonth?.index===0?precedingMonth[1]:"";
    let monthRef=month?heading?.ref:undefined, weekHeaders:PlanSourceCell[]=[];
    let weekly: {header:PlanSourceCell;entry:PlanEntry}[]=[];
    for(let i=0;i<rows.length;i++){
      const row=rows[i],head=meaningful(row[0]?.text??"");
      for(let j=0;j+1<row.length;j++)identity(meaningful(row[j].text),row[j+1].text);
      const label=monthPattern.exec(head)?.[1];
      if(label){month=label;monthRef=row[0].ref;weekHeaders=[];weekly=[];}
      if(label&&/目标|任务|规划|内容/.test(head)&&row.slice(1).some(cell=>cell.text.trim())){
        for(const cell of row.slice(1).filter(cell=>cell.text.trim())) add({subject:"",month,week:"",kind:"month",
          content:cell.text,estimated:"",sources:[row[0].ref,cell.ref]});
      }
      const headers=row.slice(1).filter(cell=>weekPattern.test(cell.text.trim()));
      if(headers.length){weekHeaders=headers;weekly=[];continue;}
      if(weekHeaders.length&&/时间|时长|课时/.test(head)){
        const labelledSubjects=subjects.filter(subject=>head.includes(subject));
        for(const cell of row.slice(1).filter(cell=>cell.text.trim())){
          const header=coveringHeader(weekHeaders,cell);
          const matched=weekly.filter(item=>item.header===header&&
            (!labelledSubjects.length||labelledSubjects.length===1&&item.entry.subject===labelledSubjects[0]));
          if(matched.length===1&&!matched[0].entry.estimated){
            matched[0].entry.estimated=cell.text.trim();
            matched[0].entry.sources.push(cell.ref);
          }else if(matched.length!==1||matched[0].entry.estimated!==cell.text.trim()){
            warnings.add("部分预计时长无法唯一对应学科或周任务，请核对原文时长行。");
          }
        }
        continue;
      }
      if(weekHeaders.length&&!label){
        for(const cell of row.slice(1).filter(cell=>cell.text.trim())){
          const header=coveringHeader(weekHeaders,cell);
          if(!header){warnings.add("部分合并单元格横跨多个周次，请核对原文。");continue;}
          const subject=subjects.find(item=>head===item||head===item+"学习"||head===item+"任务")??"";
          if(subject&&!fields.subjects.includes(subject))fields.subjects.push(subject);
          add({subject,month,week:header.text.trim(),kind:"week",content:cell.text,estimated:"",
            sources:[...(monthRef?[monthRef]:[]),header.ref,...(subject?[row[0].ref]:[]),cell.ref]});
          weekly.push({header,entry:fields.entries.at(-1)!});
        }
        continue;
      }
      const field=fieldType(head);
      if(field&&row.length>1){
        const text=row.slice(1).map(cell=>cell.text.trim()).filter(Boolean).join("\n");
        if(text)fields[field]+=(fields[field]?"\n":"")+text;
      }
    }
  }
  for(const key of ["learner","grade"] as const){
    if(labels[key].size>1)warnings.add(key==="learner"?"不同位置的姓名不一致，请核对封面和正文。":"不同位置的年级不一致，请核对封面和正文。");
    else fields[key]=[...labels[key]][0]??"";
  }
  if(fields.subjects.length>1)warnings.add("识别到多个学科标记，请在保存前核对规划和每周任务归属。");
  if(!fields.subjects.length)warnings.add("未可靠识别学科，请补充。");
  if(!fields.learner)warnings.add("未确认原件学生身份，请按原文人工核对。");
  if(!fields.grade)warnings.add("原件年级待核对。");
  if(!fields.entries.length)warnings.add("未自动识别月份或周任务，请查阅保留的原文并补充。");
  if(fields.entries.some(item=>!item.from))warnings.add("原始月份和周次保留，实际日历日期待确认。");
  if(fields.subjects.length===1)for(const entry of fields.entries)entry.subject=fields.subjects[0];
  return {fields,cells:raw.cells,warnings:[...warnings]};
}
