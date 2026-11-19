# 督学工作台 MVP v0.1

面向离线 Windows 桌面的学生学习与个人工作记录。当前验收只输入虚构学生代号和合成学习事实。

## M0 和 M1

MVP 本地分支为 `mvp/v0.1`，固定基线为 PR 1A 的 `e703144d9e3582d500a633bd6ad1a9be2623e71b`。独立 Git 仓库通过本地 Git 传输获得此提交及其历史。应用、安装器、协议、Chromium 会话和数据目录具有独立身份。

M1 从空名单开始。先新建学生代号、年级、学科、学习目标和备注，再录入日期、学科、学习任务、实际完成、测验与观察和下一步建议。保存后的学习历史按日期倒序。重新启动后，从 SQLite 读取学生及该学生的记录。

保存编号就是新条目主键。SQLite 提交后的记录是成功凭据。重复提交同一编号和相同内容会返回原条目，同编号异参会被拒绝。结果待确认时可以在当前窗口核对已保存条目或重试原编号。窗口关闭后，应先在档案和历史中核对保存结果。未确认的表单状态只保留在当前窗口。

## 数据模型与模块边界

| 对象 | M1 字段及约束 |
| --- | --- |
| `students` | UUID 主键、学生代号、年级、学科、学习目标、备注、创建时间 |
| `learning_records` | 独立 UUID、学生外键、学习日期、学科、任务、实际完成、测验与观察、下一步建议、创建时间 |
| `learning_history` | 学生、学习日期、创建时间、ID 的历史查询索引 |

SQLite 使用 MVP 专用 `application_id=0x53574d31` 和 `user_version=1`。检查主库身份后才以可写方式打开已有文件。原生初始化提交 Schema 和版本，后续业务写入使用 WAL 和 FULL 同步。主库缺失同时有初始化标记或侧车时阻断恢复性写入。遇到不同身份或未知版本时，保留原目录及侧车供处理。未来功能使用明确的 Schema 版本升级，并对受控副本验证；第一版不接入 PR 1A／1B 数据。

- Electron 主进程管理离线协议、沙盒窗口、数据根和 IPC 身份。Preload 只暴露读取学生、读取历史、新建学生和保存学习记录四个操作。
- SQLite 层负责输入校验、外键、事务、版本和保存凭据。React 层负责录入、历史和保存状态。
- 本轮预览固定使用 `D:\Codex-Development\Temp\supervisor-workspace-mvp\profile`。数据位于 `data\mvp.sqlite3`，初始化标记和 SQLite 侧车位于同一目录。Chromium、日志和崩溃转储各有独立子目录。此预览需要本机 D 盘。

## 备份设计和下一批

- **M2** 先完成本地备份导出与恢复预览。用 SQLite 在线备份捕获包含已提交 WAL 数据的一致状态。导出包记录应用身份、Schema 版本、导出时间、文件长度及 SHA-256。预览只在新隔离目录解包，验证摘要、SQLite 完整性、外键和记录数量，再展示恢复内容。恢复需明确确认，原目录完整保留，不覆盖活动数据库。工作日志再接入同一备份清单。
- **M2** 随后实现个人工作日志。工作项保存任务类型、交办来源、开始和结束时间、处理记录及状态。附件保存在 app 管理的本地目录，清单记录路径和 SHA-256。修改历史与更新同事务提交。
- **M3** 从已保存的学习事实生成约 50—100 字中文草稿，允许编辑、手动复制、标记已发送，保存所引用记录和用户确认的发送状态。草稿生成只用本地规则。最后完成备份及恢复演练、Windows 打包和实机验收。

## 运行验证

仅在获得正式执行许可后，在本工作副本加载 `Enter-MvpBuild.ps1`。脚本把 npm、Electron、electron-builder、Node 编译缓存和进程临时目录放在 MVP 专用 D 盘位置。源码构建产物留在本工作副本。测试在独立运行临时目录创建合成数据库。桌面数据和测试目录分开。

获得许可后使用锁定的 Node 24.19.0 和 npm 11.17.0，按顺序执行锁定依赖安装、类型检查、测试和生产代码构建。随后另行验收 Windows 桌面启动、新建虚构学生、保存学习记录、退出并重开查看历史。确认备份导出和恢复功能后再安排包含真实验收条件的发布。安装器仍需单独授权。

## M1 便携桌面验收包

同仓库 `mvp/v0.1` 指向 `pr/1a-windows-desktop-shell` 的 PR 在原有四项 Windows CI 步骤通过后生成 unpacked 预览包。到对应的 Actions run 下载 `supervisor-workspace-mvp-win-x64-<run-id>-<attempt>`。保留期为 7 天，下载需要仓库访问权限。预览包保留现有签名配置，不包含安装器。

操作前先确认本机策略明确允许执行下载的预览程序，并复核 C 盘至少 10 GiB 可用。确认 `D:\Codex-Development\Temp\supervisor-workspace-mvp\profile` 不存在或为空，且路径没有重解析或转向。若已有文件，先停止并保留原目录。

解压到全新的 `D:\Codex-Development\Builds\supervisor-workspace-mvp-preview\<run-id>-<attempt>`。保留以下层级。

```text
build-info.json
SHA256SUMS.txt
win-unpacked/
  SupervisorWorkspace-MVP.exe
  resources/app.asar
  locales/
  Electron 运行文件
```

启动前先核对 `build-info.json` 中的源提交、run ID、尝试编号、Windows x64 和 Electron 版本。用 `Get-FileHash -Algorithm SHA256` 逐项核对 `SHA256SUMS.txt`，确认 `win-unpacked` 没有缺失或额外文件。清单同时覆盖 `build-info.json`。EXE 依赖同目录的运行资源，启动时保留整个 `win-unpacked`。

1. 双击 `win-unpacked\SupervisorWorkspace-MVP.exe`。确认能进入学生档案界面。创建两名虚构学生，分别保存日期和学科不同的学习记录。记录保存成功提示，核对各自的历史。可用空必填项检查错误反馈。
2. 正常关闭 MVP 窗口，确认该解压目录的 EXE 进程及其 Electron 子进程退出。重开原 EXE，核对两名学生、各自历史、日期、学科和完成情况。检查有无重复、丢失或串档。
3. 完全退出后记录 Profile 的主库、初始化标记和现存侧车。SQLite 完整性核对仅在本轮合成库的一致性副本上使用 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`。若仍存在 WAL/SHM，保全它们，不单独丢弃侧车或覆盖原库。

运行会在该 Profile 下创建 `data\mvp.sqlite3`、`data\mvp.initialized` 和可能出现的 SQLite WAL/SHM，另有 `chromium`、`logs`、`crash` 子目录。进程包括 Electron 主进程、渲染进程及按需启动的 GPU 或 utility 进程。CI 验证产物结构和字节完整性，桌面启动及保存重开须由本机验收确认。

## M2-B 每日工作日志（首版）

M2-B 将工作事项保存在同一 profile 下独立的 `data\worklog.sqlite3`，使用独立 application_id、Schema v1、WAL 和初始化标记；不改动 M1 Schema v1。学生关联保存 M1 学生 UUID，并在保存时向 M1 档案核验，不建立跨数据库外键。若日志库首次初始化失败，M1 数据库仍独立存在，日志功能显示恢复错误。

首版包含工作日期、标题、可选学生、执行时间、备注、下一步、待办/完成/取消状态、自动完成时间、按日期与文本查询和修改快照历史。今日列表包含今天及之前仍未完成的事项。所有数据只在本机。

**备份缺口：** M2-A 当前备份仅覆盖 M1 SQLite 主库；独立 `worklog.sqlite3`、它的初始化标记及 WAL/SHM 侧车未纳入备份。M2-B 首版不提供工作日志备份/恢复，不能把工作日志视为已受 M2-A 保护。请仅使用合成记录进行本阶段验收。

开发验收可设置 `M2B_SYNTHETIC_TEST=1` 启动未打包应用，让 M1 和日志测试数据库位于独立的 `supervisor-workspace-m2b-test` profile；该开关不会在打包应用中生效。

## M2-C① 学生成长档案

成长档案保存在同一 profile 的 `data\growth.sqlite3`，使用独立 application ID、Schema v1、WAL 和初始化标记。M1 学生 UUID 在主进程核验，M1 年级、学科继续作为权威字段读取，不在成长库中复制。画像和提分目标有版本快照；按日期的学习行为观察只追加，编辑旧画像不会重写已保存观察。保存以唯一请求 ID 幂等处理，并以档案版本拒绝陈旧并发修改。

**备份缺口：** M2-A 备份不覆盖 `growth.sqlite3`、`growth.initialized` 或其 WAL/SHM 侧车。该库没有经过验收的备份与恢复保护；当前只允许使用虚构学生，不能用于真实学生的正式资料。

Windows 本地开发验收可设置 `M2C_SYNTHETIC_TEST=1`；便携包验收可显式设置 `M2C_SYNTHETIC_PACKAGED=1`。两种方式都可通过 `M2C_SYNTHETIC_PROFILE` 选择 1–64 位字母、数字或连字符组成的新名称，使用独立的 `supervisor-workspace-<名称>\profile` 数据目录。正式打包应用默认仍使用正式 Profile；只有显式设置便携验收开关才会切换到合成目录。运行前应确认目标目录不存在。
