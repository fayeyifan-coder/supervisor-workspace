# 督学工作台 v0.2

面向离线 Windows x64 桌面。v0.2.0 的个人限定版已用于当前获准的电脑和账户。v0.2.1 是维护候选，开发验证使用独立合成档案。真实中文 Windows 账户兼容性仍待通用发行验收。个人版接受尚未执行整机断网冷启动的风险记录。整机断电未经验证。

正式程序按提交 SHA 安装到 D:\SupervisorWorkspace\App\Versions。正式档案在 Profiles\Primary，导出默认目录是 Exports，诊断位于 Logs。合成环境必须使用独立目录。配置、版本化安装、首次激活及回切见 [正式使用准入手册](docs/production-admission.md)。

## 档案与一致性

| 数据库 | 内容 |
| --- | --- |
| mvp.sqlite3 | 学生 UUID、基础档案、学习记录、学生业务记录、修改历史和请求凭据。v0.2 正式档案使用 Schema v6。 |
| worklog.sqlite3 | 工作事项、状态、时间、修改历史及学生关联。 |
| growth.sqlite3 | 成长画像、目标、版本快照和观察记录。 |
| student-intake.sqlite3 | JSON 导入来源、学生绑定、人工核对与重试凭据。 |
| operations.sqlite3 | 排课、出勤、学习块、任务和教务请求。 |

各库有应用身份、Schema、初始化标记及 SQLite 自己的事务。跨库学生引用使用 M1 UUID。导入中的部分成功继续显示待确认。执行写入由受信 Electron 主进程准入，业务回执保留幂等恢复信息。

历史 M2-A 和早期模块独立开发时列出的工作日志、成长档案、导入备份缺口，已由正式 v0.2 的 SWBACK2 五库保护取代。历史 SWBACK1 四库包可在全新恢复副本上升级，新增教务库为空。恢复前校验镜像、版本、标记、摘要、完整性与跨库关系。恢复只生成独立副本，活动档案原位覆盖保持 HOLD。

## 本地导出、独立介质与切换

1. 在「学生档案 → 离线数据保护」选择「导出完整备份」，先导出到安全的本地固定 NTFS 磁盘。等待应用确认写入和校验完成。
2. 保留完整 SWBACK2 文件。用 Get-FileHash -Algorithm SHA256 核对本地文件摘要。
3. 把同一个完整文件复制到已获准且已加密的独立备份介质。对副本复算 SHA-256，逐字核对与本地摘要一致。确认后安全弹出并独立保管。仅在同一物理盘各分区留存副本，仍承担整盘故障风险。
4. 页面显示当前档案最近一次成功校验导出的时间，超过三天提醒。提醒不阻止工作。历史时间不能证明文件仍存在，独立介质副本须单独核对。取消导出或导出失败保留原有时间。时间记录按档案保存，恢复副本从无记录开始。
5. 激活恢复副本或返回原始档案前，关闭或保存草稿，结束进行中的操作并核对待确认请求。最终确认后程序正常退出，重开进入目标档案。关闭或切换提交失败时保留原档案与恢复资料，先核对提示和实际活动档案。

主进程为五库同时取得 SQLite 写入保留锁，镜像纳入已提交的 WAL 数据。固定 NTFS 和原生文件安全约束继续生效。可信单用户模型下，同权限恶意进程主动修改本机数据仍不在保护范围。

## 开发、Windows CI 与升级

开发环境为 Node 24.19.0 和 npm 11.17.0。Node 版本由 .nvmrc、engines 与预检共同约束。Electron 45.3.2 内置 Node 24.22.2，随 x64 产物运行，桌面用户无需独立安装开发 Node。依赖锁按既有版本维护。

在独立 Windows 工作树加载 Enter-MvpBuild.ps1 的开发环境，然后运行：

```powershell
npm run preflight
npm ci
npm run typecheck
npm test
npm run build
```

Windows CI 构建同一固定提交的 x64 产物，并校验 ASAR 白名单、原生恢复组件和 SHA-256。真实打包 Electron 冒烟使用全新合成档案，验证保存重开、SWBACK2 导出及恢复切换。ASAR 检查直接使用锁定的 @electron/asar 3.4.1。新增运行模块须在 workflow 中明确列入白名单。依赖告警仅按可信构建输入和锁定依赖条件接受。

诊断日志使用 JSON Lines，每份上限 128 KiB，保留当前文件及两份轮换文件。仅记录时间、程序版本、通道、错误类别和核验过的可选 SQLite 数值错误码。诊断写入失败时仍返回业务自身结果。

升级前关闭 v0.2.0，先导出和校验完整 SWBACK2，再从未来经批准的实际 main Windows CI 安装新版本目录。现有数据库 Schema、SWBACK2 格式和正式档案目录保持兼容。保留 v0.2.0 程序和原入口，使用隔离合成档案验证后另行确认正式快捷方式更新。新版已有写入时，回退前先停写并导出、核对当前档案，保留新增记录。

历史方案见 [M2-D 设计和验收](docs/m2-d-offline-protection.md) 和 [升级演练](docs/m2-d-upgrade-rehearsal.md)。

## Public repository privacy

Real business data, backups, imported institution files, exports and browser profiles must stay outside this checkout. Use only reviewed synthetic fixtures in tests and screenshots. Do not attach real student information or credentials to public PRs, issues or CI logs.

Before committing, run `node scripts/check-sensitive-files.cjs --staged`; use `--tracked` for the full index and `--history BASE..HEAD` for a proposed revision range. Findings are redacted. Ignore rules do not remove data from prior commits or block forced additions by themselves. See [data privacy and fixture rules](docs/data-privacy.md). This guard does not replace human review or authorize a release.

