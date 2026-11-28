import {lstatSync,mkdirSync,readFileSync,realpathSync,renameSync,unlinkSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {planId,planObject} from "./study-plans";
import type {DailyInput} from "./learning-daily";
import {WorkspaceFault} from "./workspace-fault";

const name="quick-learning-drafts";
const invalid=()=>{throw new WorkspaceFault("recovery","本机快速登记草稿无法核验。请保留档案并重新打开。");};
const maxBytes=16*1024;

export class DailyDrafts {
 constructor(private readonly profile:string){}
 private path(student:string,create:boolean){
  const root=join(this.profile,name);
  let item=lstatSync(root,{throwIfNoEntry:false});
  if(!item){
   if(!create)return;
   mkdirSync(root);item=lstatSync(root);
  }
  if(!item.isDirectory()||item.isSymbolicLink()||realpathSync.native(root)!==root)return invalid();
  const path=join(root,planId(student)+".json");
  const file=lstatSync(path,{throwIfNoEntry:false});
  if(file&&(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.size>maxBytes||realpathSync.native(path)!==path))return invalid();
  return {root,path,exists:Boolean(file)};
 }
 private check(raw:unknown,student:string):DailyInput{
  const row=planObject(raw);
  if(row.studentId!==student||!planId(row.id)||typeof row.date!=="string"||typeof row.subject!=="string"||
    typeof row.content!=="string"||!Array.isArray(row.tags)||row.tags.some(x=>typeof x!=="string")||
    !["problem","intervention","next","completion","mastery","source"].every(key=>typeof row[key]==="string"))return invalid();
  return row as unknown as DailyInput;
 }
 read(student:string):DailyInput|null {
  const file=this.path(student,false);
  if(!file?.exists)return null;
  return this.check(JSON.parse(readFileSync(file.path,"utf8")),student);
 }
 save(student:string,raw:unknown){
  if(raw===null){
   const file=this.path(student,false);
   if(file?.exists)unlinkSync(file.path);
   return null;
  }
  const draft=this.check(raw,student),json=JSON.stringify(draft);
  if(Buffer.byteLength(json)>maxBytes)return invalid();
  const file=this.path(student,true)!;
  const temp=join(file.root,".pending-"+randomUUID());
  writeFileSync(temp,json,{flag:"wx",flush:true});
  try{renameSync(temp,file.path);}catch(error){unlinkSync(temp);throw error;}
  return null;
 }
}
