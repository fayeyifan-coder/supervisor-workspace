# 第一批维护与体验联合候选

基础 main `a1e5a3b49fe50a8a7db75d219d351e82f9680911`；独立分支 `release/batch1-maintenance-ux`。没有合并或改动 main。

## 固定组合与独立边界

- PR 15：`b26a2c1fb48ee862a3c7adc789b341121877ef2c`，两个维护提交，独立审查见 [报告](batch1-pr15-review.md)。
- PR 16：先核实用户指定 `2861c96ccc5fd3272856126eff9ad5ae2c418f23`，再纳入本次学科往返修复后的 `73b9a009194bd34328452cd640c0efbea4eb004d`。新增差异仅为持久清除失效选择、说明及真实组件回归。
- PR 17：先核实用户指定 `8ede9c985c3518f4bd622db8bcf9c1e0d6c9d927`，再纳入本次学生往返修复后的 `9eb240cc2fb0185d5e2157e32262211a05312c58`。新增差异仅为清除旧学生显式页签及实际应用回归。

每项源提交以 cherry-pick -x 独立保留归属。renderer.tsx 自动整合后同时保留维护安全逻辑及成绩学生隔离参数。没有夹带排名、删除、排课或其他业务实现，没有修改 schema 或 SWBACK2。

仓库发布记录及远端 tags 本次均为空。发布方案采用 v0.2.1，沿用维护候选内置版本，未创建 tag 或 Release。它仍是审核候选，不代表正式发布或升级许可。

## 实际验收

联合目录重新执行全部测试，实际结果 139/139，0 失败、0 跳过；没有把三个 PR 的历史通过数相加当成联合运行。类型检查、生产构建、Windows x64 打包通过。

以下脚本重新运行，均只创建独立合成根，不读取系统剪贴板或正式学生数据库：

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run pack:win:dir
node scripts/smoke-electron.cjs release/win-unpacked/SupervisorWorkspace-MVP.exe
node scripts/score-acceptance.cjs <候选EXE> <证据目录> candidate
node scripts/profile-acceptance.cjs <候选EXE> <证据目录> candidate
node scripts/profile-acceptance.cjs <候选EXE> <证据目录> legacy
node scripts/legacy-backup-acceptance.cjs <固定旧版0.2.0副本EXE> <候选EXE> <证据目录>
```

运行 Node 24.19.0，并将进程 TEMP/TMP/TMPDIR 设为仓库既有批准的测试目录。npm ci 使用锁文件，Electron 45.3.2、electron-builder 26.18.0、ASAR 3.4.1。固定 HEAD、工具链、构建步骤和产物摘要共同确定可重建身份；不承诺不同构建机或时间生成字节完全相同的 ZIP。

smoke 覆盖 17 写入门禁、草稿及待确认协调、正常退出、强退和提交失败、五库备份恢复回切、备份提醒隔离、日志白名单及轮换。成绩脚本覆盖统一得分率、满分/类别、同日及补录编辑、跨学生延迟读取、学科消失后重新出现；档案脚本覆盖 A-B-A 重置、同学生刷新、草稿、busy/丢失回执、三类延迟响应和 20 学生。

旧版兼容脚本使用实际 0.2.0 程序创建五库合成内容并导出 SWBACK2，包含成绩、家长诉求、学习历史、导入及成长、工作日志、排课、签到签退、学习块和任务完成。业务时钟仅在该合成主进程中固定，不改系统时钟。候选先独立恢复，24 表定义和全部业务行与源一致，再实际激活读取并回切；原五库和原备份哈希不变。

CI 应按新联合 PR 固定 HEAD 重新判断。保留原有打包和实际 EXE smoke 工作流，不改变上传、保留策略或失败规则；Artifact 配额不足仍为 failure。没有联合 CI 全绿前不得报告全绿。

## 停止条件

Phase 1B 满分变化仍尚未复现；本批没有输入修复。正式安装、Primary、快捷方式与用户备份未变。正式升级方案见 [准备文档](batch1-upgrade-plan.md)，只制定方案。最终停止在独立联合 Draft PR 审查阶段。
