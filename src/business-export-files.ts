import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { BusinessExportDocument, BusinessExportResult } from "./business-export";
import { businessExportPayload } from "./business-export";
import { WorkspaceFault } from "./workspace-fault";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const within = (root: string, path: string) => {const part = relative(root,path); return !isAbsolute(part) && part !== ".." && !part.startsWith("..\\");};
export function requireExportDestination(parent: string, forbidden: readonly string[]) {
 if (!/^[A-Za-z]:\\/.test(parent) || forbidden.some(root => within(root,parent))) throw new WorkspaceFault("invalid", "请选择正式程序、档案与业务数据目录以外的导出位置。");
 for (let cursor = parent;; cursor = dirname(cursor)) {
  if (existsSync(join(cursor,".git"))) throw new WorkspaceFault("invalid", "业务导出不能保存到 Git 仓库内，请选择仓库外的本机目录。");
  if (dirname(cursor) === cursor) break;
 }
}
export class BusinessExportFiles {
 constructor(private readonly helper: string,
  private readonly available = (parent: string) => {const stat = statfsSync(parent); return Number(stat.bavail) * Number(stat.bsize);}) {}
 async publish(parent: string, document: BusinessExportDocument, forbidden: readonly string[], leaf = "sw-business-export-" + randomUUID().replaceAll("-", "")): Promise<BusinessExportResult> {
  requireExportDestination(parent, forbidden);
  if (!/^sw-business-export-[0-9a-f]{32}$/.test(leaf)) throw new WorkspaceFault("invalid", "导出目录身份无效。");
  const payload = await businessExportPayload(document);
  const lengths = payload.files.map(file => file.bytes.length); const total = lengths.reduce((a,b) => a+b, 0);
  if (total > 96*1024*1024 || this.available(parent) < total + 16*1024*1024) throw new WorkspaceFault("failed", "导出空间不足或文件超过 96 MiB 上限，未写入任何导出文件。");
  const location = join(parent,leaf);
  const expected = Buffer.from("sw-business-export-v1\n" + sha(payload.files[2].bytes) + "\n");
  await new Promise<void>((resolve,reject) => {
   const child = spawn(this.helper,["publish-business",parent,leaf,...lengths.map(String)],{windowsHide:true,shell:false});
   const chunks: Buffer[]=[];let size=0;let failed=false;
   const failure=()=>reject(new WorkspaceFault("failed", "业务导出未完成，请保留可能留下的不完整目录并重新预览。位置："+location));
   child.stderr.resume();child.stdin.on("error",()=>{failed=true;});
   child.stdout.on("data",(bytes: Buffer)=>{size+=bytes.length;if(size>1024){failed=true;child.kill();}else chunks.push(bytes);});
   child.once("error",failure);
   child.once("close",code=>{if(code!==0 || failed || !Buffer.concat(chunks).equals(expected))failure();else resolve();});
   for(const file of payload.files) child.stdin.write(file.bytes);
   child.stdin.end();
  });
  return {location,snapshotId:document.snapshotId,capturedAt:document.capturedAt,rows:payload.manifest.rows,longTextCells:payload.manifest.longTextCells,
   files:[...payload.files,{name:"export.complete",bytes:expected}].map(file=>({name:file.name,bytes:file.bytes.length,sha256:sha(file.bytes)}))};
 }
}
