import type {DatabaseSync} from "node:sqlite";
import {WorkspaceFault} from "./workspace-fault";

export const backupDatabaseLimit=32*1024*1024;
export const backupDatabaseWarning=26*1024*1024;
const names=["学生档案","工作日志","成长档案","学生导入","教务"] as const;
export interface BackupCapacity {limit:number;warning:number;stores:{name:string;bytes:number}[]}

export function databasePages(db:DatabaseSync){
 const pageSize=Number(db.prepare("PRAGMA main.page_size").get()?.page_size);
 const pageCount=Number(db.prepare("PRAGMA main.page_count").get()?.page_count);
 const bytes=pageCount*pageSize;
 if(!Number.isSafeInteger(bytes)||bytes<0||!Number.isInteger(pageSize)||pageSize<512)
  throw new WorkspaceFault("recovery","无法确认本机数据库的备份容量。");
 return {pageSize,pageCount,bytes};
}
export function applyBackupPageLimit(db:DatabaseSync){
 const {pageSize,bytes}=databasePages(db);
 const limit=Math.floor(backupDatabaseLimit/pageSize);
 if(bytes>backupDatabaseLimit||Number(db.prepare("PRAGMA main.max_page_count="+limit).get()?.max_page_count)!==limit)
  throw new WorkspaceFault("recovery","数据库超过当前离线备份容量。请保留档案和已有备份。");
}
export function readBackupCapacity(dbs:DatabaseSync[]):BackupCapacity{
 return {limit:backupDatabaseLimit,warning:backupDatabaseWarning,
  stores:dbs.map((db,index)=>({name:names[index]??"其他数据库",bytes:databasePages(db).bytes}))};
}
