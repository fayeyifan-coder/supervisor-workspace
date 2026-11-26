# PR 15 第一批联合候选独立审查

审查固定源码为 `b26a2c1fb48ee862a3c7adc789b341121877ef2c`，基础 main 为 `a1e5a3b49fe50a8a7db75d219d351e82f9680911`。本次重新阅读实际差异并重新执行测试与打包应用验收，没有把历史 PR 记录当作本次通过证据。

## 审查结果

| 范围 | 代码证据与本次验证 |
| --- | --- |
| 全部写入及导入入口 | main.ts 的 17 个业务写入/可变导入预览入口全部使用 handleWrite，经可信主框架校验后登记 ProfileWriteGate；已有静态注册清单测试和真实进程 17 入口拒绝测试重新通过 |
| 进行中与迟到写入 | gate.write 在 finally 释放计数；gate.protect 要求无 writer，保护期间和 state.pending 期间拒绝新写入；异步选文件也在 writer 范围内 |
| 切换准备 | 检查五库连接、基础编辑 pending、导入未完成状态、教务 journal 和学生资料持久凭据；然后询问 renderer 草稿/忙碌/学习状态。选择前、最终对话框前及冻结前重查，避免只在入口检查 |
| renderer 协调 | 受控表单的 dirty/busy 与标记表单的实际值/defaultValue 一起检查；确认时 body.inert；没有强制卸载详情树来清草稿 |
| 正常退出 | 最终确认仅安排 state.pending，下一事件循环正常 app.quit；will-quit 逐个关闭存储后才提交活动选择，任一关闭失败不提交。未退出时 5 秒后解除冻结并报告未安排切换 |
| 异常恢复 | 本次实际故障注入覆盖取消、未保存草稿、选择文件中、待确认请求、迟到写入、退出被阻止、选择记录提交失败和 will-quit 前强退，重新启动核对原活动档案及往返回切 |
| 备份状态 | 成功导出和校验后才写活动 profile 下的独立时间戳，取消及失败不更新；恢复副本无原 profile 的时间戳，返回原档案恢复原时间；超过三天为非阻塞提醒 |
| 日志 | 仅允许 time/version/channel/category/sqliteCode；channel 与 category 使用白名单，版本须为三段数字，SQLite 码为有界整数。无 error.message、SQL、路径、学生 ID 或业务 payload。128 KiB 单文件上限，最多当前及两个历史文件；失败不改变业务返回 |
| 兼容性 | database.ts、student-intake.ts 只新增 pending 状态查询；DDL、成绩 payload、SWBACK2 和原生恢复格式未改 |
| Windows CI 实际应用 | PR 15 工作流新增打包应用 smoke 步骤；本次独立本地重新执行同一实际 EXE 冒烟，联合 PR 的新 CI 也保留执行此步骤 |

本次固定 PR 15 单独运行 123/123 测试、类型检查、生产构建、Windows x64 打包及实际应用 smoke 全部通过。smoke 最终输出包含 lateWritesRejected:17、pendingAndInFlightRejected、failedQuitRecovered、commitFailureReported、interruptedBeforeQuit、roundTrip、backupStatusIsolated、backupReminder、diagnosticsSanitized 均为 true。

## renderer 重叠核对

三 PR 组合时 renderer.tsx 自动三方整合，无冲突标记。复核保留 PR 15 的 workspaceInfo、profileSwitchReady/profileSwitchCancel、受控与非受控草稿检查、冻结取消、四/五库提示和相关 props；同时保留 PR 16 ScoreTrend 的 studentId 参数。主进程 gate、诊断和备份状态实现与 PR 15 固定版本相同，联合动态测试重新验证它们。

## 结论与边界

独立审查在可信单用户 Windows、合成隔离档案及列明的进程级故障范围内 PASS，未发现阻断联合候选准备的问题，不需要修改 PR 15 业务实现。此结论不是正式部署批准。

整机断电、存储控制器行为、同账户恶意并发改写，以及真实中文 Windows 账户完全断网冷启动仍不由这些测试证明。备份时间戳只表示当次本地导出校验成功，不证明备份仍存在或已放到独立介质。日志白名单和轮换是正常使用保护，不抵御同权限进程主动替换。正式备份与升级验收另行授权。
