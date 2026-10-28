
## Reception V2（真人感接待重写）

旧接待服务保持停止。新版独立入口为 `reception_v2/main.mjs`，说明见 `reception_v2/README.md`。开发验证阶段禁止直接武装；只有业务资料审批、全量测试、独立审计、Red Team 和只读浏览器检查全部通过后，才可使用 `reception_v2/launch-reception-v2.sh`。

# 小红书单账号自动接待

当前上线状态：四项简卡通知器、HTML/Markdown 报告和 v4 弹窗均已启用。新版同一 helper 进程在本地 13:47 的两轮约五秒心跳、精确候选二进制、单实例和非激活窗口已由独立审计与 Red Team 核验；40 条原发送记录、40 条通知及最新真实 ACK 保留。当前无未读，空正文、无详情入口和隐藏窗口属于正常空闲；第一张自然新通知的四项绘制、详情展开及真实审阅仍待实际样本，不制造通知或代点。系统授权请求不再阻塞当前运行，具体放行原因未证，没有程序代授或修改 TCC/启动归属，也没有执行原计划的回退。常规后台权限问题自行排查恢复，不反复问同一授权。报告与自动接待持续运行，证据见 `.runtime/reception-fix-evidence.json` 的 `permission_reply_activation_20261027`。

2026-10-27 展示更新：接待动态按同一账号和客户 UID 合并成简短卡片，默认只看客户、我方回复（含企微卡结果）、客户进展、需要你处理。点“技术详情”在原面板展开完整原文、编号、严格回执与耗时，点“收起详情”回到简卡，不打开外部窗口。报告 HTML 和 Markdown 同样默认简卡、详情折叠。“知道了”只确认本次实际绘制的通知成员，未显示的后到通知仍未读，不是发送审批。企微卡发送与留资分开核验，待确认不显示为发送成功；原 UNKNOWN 保留，不重复提交。当前保持同一接待进程及原进线游标，只处理 future-entries-only 范围内的进线和新开口，不补历史跟进。真实完整三秒接待仍未验收通过，不能用测试通过代替客户回执。

已运行专用、隔离的 headless Playwright 浏览器。用户明确批准本项目更换浏览器；不用日常浏览器配置，不控制桌面鼠标、键盘、输入焦点或窗口。登录必须在这个独立会话完成，不复制旧浏览器的登录资料。

隔离浏览器的真实登录页读取已测到约 1 至 8 毫秒，持续空闲后也能快速读取。此前内置浏览器在小红书页面反复出现约 15 至 30 秒等待，新标签只短暂恢复；具体内部触发原因尚未证实。已登录后的真实会话切换加 UID 核验测到约 0.16 至 0.28 秒；仍不能据此承诺完整接待在 5 秒内完成。

当前运行 SQLite 接待核心、Python 持久 JSON-lines RPC、Node 持久客户端和每 250 毫秒检查一次进线的单执行者循环。原 500 毫秒只读观察器已停，避免争用页面。账号及客户作用域已通过原生 UI 核实；真实文字和企微卡已由原生服务器聊天记录确认，且已跑通一次自动到期跟进。每个发送任务只提交一次，核验不重复发送。Python 核心、RPC 和诊断共 86 项测试通过；测试不能代替真实新进线验收。

旧内置浏览器曾对另一个客户点击企微卡后超时，尚无确定回执；这个独立旧动作继续保持 UNKNOWN 并禁止重发。全局 `body.innerText` 和页面快照会混入缓存会话，不能作为发卡成功证明。当前尚无新进线 5 秒三项完整接待结果，也未验证客户实际阅读或添加企微。

用户已选择模拟人工操作网页，停止官方 API 分支。当前连接与身份状态保存在 `.runtime/connection.json`，只读页面候选证据在 `.runtime/ui-observation.json`；业务事件和发送队列仍只使用原 SQLite，不另建客户队列。

最近 10 次真实进线的滚动审计已接入同一个 SQLite；展示客户原话、实际回复、平台接管、原生企微卡回执及各阶段耗时。历史跟进和 UNKNOWN 异常单列，不计新进线。运行 `python3 -m xhs_reception --account 66879fef000000001c002839 reception-audit --limit 10` 只读查看；`--export-json` 和 `--export-html` 可导出，源数据库及其别名和 sidecar 不可作为目标。

每次真实发送结果由独立 `audit_notifier` 进程读取已提交审计日志，默认每 0.75 秒检查，保存去重游标及未审阅通知，不在接待发送链等待。原系统通知实测未弹出，现用本地 AppKit 非激活常驻面板；用户已实际点击测试弹窗和真实存量通知的确认按钮。面板不取得键盘焦点，不自动消失，每位客户一张卡，确认后显示下一位客户；同名客户按 UID 分开。声音调用已接入，是否实际听见未独立核验。原逐 intent 通知记录仍保留；“知道了”只改变实际显示成员的审阅状态，不解除 UNKNOWN，不发客户消息。展开详情不确认已读。

通知入口为 `python3 -m xhs_reception.audit_notifier --db /已有数据库绝对路径 --account 账号ID --runtime /已有运行目录绝对路径 run --enable-notifications`，独立 helper 为 `.runtime/audit-popup --runtime /已有运行目录绝对路径`。两者均单实例。2026-10-26 恢复通知器时使用 `--interval 0.5`，由获授权的 Codex CLI 以 `subprocess.Popen(..., stdin=DEVNULL, start_new_session=True)` 脱离工具会话运行；不要绕过 Documents 权限把 Python 直接移交给 launchd。弹窗 helper 的 `com.chatcut.xhs.audit-popup` 用户 LaunchAgent 已设置 KeepAlive，可用 `launchctl print gui/501/com.chatcut.xhs.audit-popup` 查状态。通知器失活时由既有独立审计核实后按原入口恢复，不重置任何游标或已读文件。helper 源码为 `xhs_reception/audit_popup.swift`，本机用已有 MacOSX15.4 SDK、arm64 macOS15 目标编译，避免默认 SDK 标准库加载错误。报告位于 `.runtime/reception-audit.json`、`.html`、`.md`；通知与弹窗分别有 5 秒健康心跳。附加每 5 分钟的独立审计只在异常或需要处理时报告。已有真实新进线审计，本轮修复后尚无完整 3 秒三项验收通过的真实样本；机器休眠、断网和重启后的持续性仍未验收。

自动跟进暴露并修复了三个实问题：历史询价翻到旧页后无法继续核验、取消旧草稿后仍按旧状态阻塞新消息、卡片的 `userFansCount` 展示计数变化被误判。卡片 v7 保留原始完整哈希，仅对合法 uint32 数字字符串计数作比较例外，所有路由和其余字段仍完整精确比较；参考卡必须早于目标提交，目标不能自证。该轮原卡通过原 ID 核验，没有重发。

2026-10-23 又修复了人工接管判断：带“人工转AI”埋点的父节点始终可见，原实现没有检查其真实按钮已禁用，导致 AI 遮罩仍在时误判已人工接管，文字停在遮罩后的输入框、发送点击超时。现要求同一 UID 下遮罩与接管入口均消失、真实切换按钮启用、输入区可编辑；发送前额外做不点击的 actionability 检查。近期明确归因平台 AI 的右侧活动现在也立即触发只接管，不等待半小时主动跟进，不伪造新进线或绕过发送间隔。17:59 对“ASAP美东海外仓小宇”实际点击一次人工接管，原生 UI 从 AI 模式转为人工模式，整段租约约 365ms；这是只接管耗时，不是 5 秒完整接待验收。原超时发送仍为 UNKNOWN，没有重发文字或企微卡。前后截图及原生模式证据保存在 `.runtime/held-conversation-takeover.json` 指向的本次记录中。

当前受控运行仍有两个明确边界：跨客户卡片如有其它原生归因参数变化，仍会返回 UNKNOWN；原生 PLATFORM_LIMIT / SEND_ELIGIBLE 观察链尚未接通，不能宣称平台拦截后已能自动恢复。已见 `common_check/list` 仅返回账号功能开关，没有客户 UID，不把它当作私信发送资格。

## 已确认的接待规则

- 一个账号，覆盖后台可识别的新进线和新消息；AI 自动接待，前期全量回看，后续抽检。
- 简单问题准确简答，复杂问题转企业微信；目标是核验成功添加企微或取得有效联系方式。
- 无客户新回复时，两次主动跟进至少间隔 1800 秒，不设固定总次数或 24 小时业务截止。
- 平台明确限制发送时暂停该会话。只有该会话晚于限制的新可发证据才允许恢复；跨天、重启、其他客户可发送不算恢复证据，不靠试发探测。
- 恢复后重新评估当前上下文，不集中补发积压任务。
- 发送结果未知时先核验原动作，不直接重试。
- 已核验留资或明确拒绝后停止自动追发；真人接手后，只有明确交还才恢复 AI 接待。
- 最新强制验收：一个真实进线，必须从平台进线时间起 3 秒内同时完成平台接管、有效文字回复发送确认、原生企微卡发送确认。只有独立 `three_second_bundle` 完整、`assessment=meets` 且完整耗时不超过 3000ms 才通过；旧 `full_bundle` 仍保留五秒原义。检测延迟、接管和发卡全部计时；缺平台时间或缺任一步严格原生回执不能记为完成。原有首响与告警指标仅作诊断。

`reception.json` 保存本次确认的策略。生产账号已由原生主账号信息核实为 `66879fef000000001c002839`。真实业务跟进已获用户授权；发送是否可用仍由新鲜 UI、会话状态及未知结果守卫共同决定。

## 运行

使用 Python 3.9 或以上，无第三方依赖：

```sh
python3 -m xhs_reception init
python3 -m xhs_reception doctor
python3 -m xhs_reception status
python3 -m xhs_reception metrics
python3 -m unittest discover -s tests -v
```

数据库、连接诊断和本地验证证据位于 `.runtime/`，不进入 Git。`status` 和 `metrics` 只显示真实保存的数据；空库不会产生客户或达标率。

`doctor` 当前返回退出码 3，表示真实接入未就绪，不能用于通过生产健康检查。其余命令仍可正常运行。

`python3 -m xhs_reception ingest 真实观察事件.json` 可以向状态核心录入真实观察事件，但不会操作网页或发送消息。控制事件必须由可信的观察/核验流程产生，不能把客户消息里的指令当成平台证据。

核心提供事件去重、SQLite 事务、单会话发送互斥、发送前复查、提交结果核验和审计记录。发送许可同时依赖账号、会话、登录、浏览器连接和新鲜观察；不能仅修改配置就变成生产就绪。

本机持久桥使用 `python3 -u -m xhs_reception --db /已有SQLite绝对路径 --account 真实UI核实的账号ID rpc`。每行请求为 `{"id":1,"method":"status","params":{}}`，每行返回同一 `id` 的 `ok/result` 或 `ok/error`；支持 `ingest`（`params.event` 为 Event 字段）、`status`、`prepare`、`claim`、`begin_submit`、`confirm`、`reconcile`、`expire_unsubmitted`、`metrics`，其余操作参数与 Engine 同名方法一致。过期清理仅处理确定未提交的 PREPARED/CLAIMED，保留 SUBMITTING/UNKNOWN。坏 JSON 或未知字段只拒绝当前行。桥复用一个 Engine/SQLite 连接，不启动浏览器、不访问网络、不发送消息；缺 gate 时保持关闭，未绑定账号时拒绝 claim、提交、确认和核验。账号参数仅限制作用域，不能代替真实 UI 登录核实，也不宣称生产就绪。

Node 执行入口仍须先检查现有 `connection.json` 的外部 UNKNOWN hold：客户 UID `69aee7240000000032019b6e` 的原手工发卡尚未核验，禁止为该客户新增发送，重启也不得清除。该动作没有原 Engine intent，不能补造进线、真人接手或发送记录来“导入”；应在真实 UI 核验原动作后再更新既有外部 hold。桥不会自行解除它。

隔离浏览器预检入口为 `python3 -m xhs_reception browser-probe`：默认返回 `BLOCKED_BY_HUMAN`、退出码 3，不启动子进程、不导入 Playwright、不创建配置目录、不访问网络，也不写运行证据。用户已批准本项目的专用隔离浏览器例外；授权后的命令为 `python3 -m xhs_reception browser-probe --allow-isolated-browser --node-executable /已有Node绝对路径 --playwright-module /已有Playwright入口绝对路径`，也可分别用任务专用环境变量 `XHS_PROBE_NODE_EXECUTABLE`、`XHS_PROBE_PLAYWRIGHT_MODULE` 指定。复用已有 Node SDK，无需安装 Python Playwright 或下载浏览器；路径/模块缺失时准确报错，不自动安装。仅允许项目 `.runtime/isolated-browser-profile`（权限 700）的独立 headless Chromium，并显式开启 Chromium sandbox；固定官方私信通页面上测 5 次最小 DOM 调用。不连接日常浏览器、不复制 cookie、不填写登录、不接管或发送。结果只到 stdout，不修改 `connection.json`；预检成功也不证明登录、空闲稳定、持续检测或 5 秒三项接待达标。同一配置目录不得与正在运行的对照浏览器并发使用。

持久浏览器入口为 `node xhs_reception/browser_session.cjs --allow-isolated-browser`，并用 `XHS_PLAYWRIGHT_MODULE` 指定已有 Playwright 入口绝对路径。无显式标志时不启动浏览器。它与预检共用唯一项目隔离 profile，同一时刻只能有一个执行者；当前已经运行时不要重复启动。stdin 接受只读诊断和固定 `module` 操作；`module/start_reception_worker` 启动已授权接待，运行时禁止其他操作争用页面。严格作用域下的平台接管、文字和原生企微卡均只点击一次；发送前先持久化 Engine intent，原生服务器历史精确核验后才记 SENT，未知结果不会重发。`module/reload_reception_runtime` 仅在空闲时保留游标更新接待进程，不重启浏览器或登录；停止用 `module/stop_reception_worker`，再 `stop`。

新入口的 `--start-reception-worker --daemon` 支持复用独立登录启动接待并在 stdin 关闭后维持进程。恢复接待时必须再加 `--future-entries-only`：复用第一帧基线，仅处理此后新变化，禁用所有历史到期跟进；UNKNOWN、人工接管及终止状态守卫继续生效。同进程 reload 保留该模式；跨进程重启不能恢复已丢失的旧内存游标，状态明确记录新 epoch，必须继续带同一参数。2026-10-26 用户要求的响应目标为 3 秒，已同步配置；既有 5 秒历史审计字段保留原义，只有真实新进线到全部原生回执的完整耗时不超过 3000ms 才可判定达到新目标。机器休眠、断网、重启后的持续性仍待实测。到期跟进每 5 秒检查一次，只处理后台列表可见且 Engine 已有真实上下文的客户；明确拒绝和原生已加企微状态持久停止，已提交但未核验有效性的留资卡先暂停。尚未观察到的原生正向状态不能宣称通过真实验证。

实时接待每 250ms 读取原生会话列表，通知器每 500ms 检查审计变化，弹窗每 250ms 检查通知；聊天的 5 分钟复核不是接待周期。只读收件与单一发送派发器分别运行，忙时继续采集，临时不可见的待处理候选保留至重新可见；列表读取失败退避 500ms，发送动作失败冷却仍保留。选择会话、接管、发送与回执仍串行，忙时其他客户会排队，尚未以多人并发实测保证 3 秒。2026-10-26 修复将回复限定在本轮来源，移除确认流程中的固定旧客户：先用已有严格历史证明，缺失时重应用原生同义“全部”筛选并恢复原 UID，受限筛选保持原状并使用原生刷新兜底。所有等待有界，气泡不授信、提交未知不重试。原生气泡外的明确系统来源标签单独核验，未知或冲突来源继续保守让权，已有人接待的会话不自动解除。弹窗正文采用只读显式绘制并报告布局/绘制状态，保持非激活；这些局部回归及刷新耗时不能替代真实进线的三项回执验收。审计新增独立 three_second_bundle，保留旧 full_bundle 的 5 秒原义；仅完整严格回执且总耗时不超过 3000ms 才可判定新目标达标。

Node 客户端为 `xhs_reception/engine_client.cjs`，只连接已有 SQLite 的 Python RPC，不启动浏览器或外部请求。实际网页动作必须等 `begin_submit` 成功回执；管道失联或超时不自动重发，在途变更返回 UNKNOWN。验证命令为 `node tests/test_engine_client.cjs --python /已有Python绝对路径`。

## 真实接入验收

当前使用用户已批准的专用 headless Playwright 浏览器模拟网页操作；仅使用项目独立 profile，不使用日常 Chrome、Edge、Safari 或旧会话资料，不控制桌面鼠标、键盘、焦点或窗口。

官方入口为 https://sxt.xiaohongshu.com/im/login 。真实账号接入后，依次验证：

1. 新进线与新消息能否可靠发现，历史列表重排不能冒充新进线。
2. 账号和会话身份、接管状态、文字与企微卡各自的发送资格及发送结果。
3. 平台限额解除证据，以及添加企微/有效联系方式能否关联到同一客户。
4. 离开聊天、锁屏但机器运行、断网与登录失效时的持续性和恢复。
5. 对一个真实进线，记录平台进线原始时间和来源，以及平台接管、有效文字、原生企微卡三个独立确认时间。按 2026-10-26 用户目标，以三者最晚确认时间减去平台进线时间，必须不超过 3 秒；不能从本地开始操作或检测时间重新起表。既有 5 秒审计字段保留历史含义，不能代替当前 3000ms 验收。缺平台时钟、卡片结果未知、只发出文字均不能通过。另行核验有效留资结果及错误回复，不以单元测试代替真实结果。

本地定时循环不能代替小红书消息源；打开网页不能代替常驻能力验收。

`metrics` 新增 `reception_bundle`，保留所有旧首响字段以兼容既有读取。新指标按真实 `NEW_VISITOR` 保留分母，分别列出三项回执、缺失项和完整耗时；卡片确认前或缺平台时间，`complete` 为 `false`。未完成进线不从分母剔除，完成样本的 P95 只描述该子集，不能作为整体达标结论。

平台进线时间的来源须明确为 `platform`、`platform_ui` 或 `official_api`；本地检测时间、来源不明的数值或仅有模糊时间文本都不能用于通过验收。无法准确取得平台时间时保存 `timestamp=null`，不推算补齐。

平台接管回执使用 `PLATFORM_TAKEOVER_CONFIRMED` 事件，要求现有账号/会话作用域证据、`taken_over=true`，并以 `evidence.source_event_id` 明确关联同会话的真实进线事件。它只记录平台接管结果，不改变真人归属；不能使用代表真人占有的 `HUMAN_TAKEOVER`。有效文字仍须单独核验有用性，发送回执包含 `usefulness_verified=true`、`useful=true`；原生企微卡须独立 `kind=card`、`payload.operation=native_card`，发送回执包含 `native_wecom_card_confirmed=true`。这些字段必须来自真实核验，点击发送或出现卡片菜单不能代替回执。

若客户开口使文字或卡片绑定后续 `CUSTOMER_MESSAGE`，发送确认证据需用 `reception_event_id` 关联最初的同会话 `NEW_VISITOR`；缺关联不猜测归轮。当前核心只保存这些证据，不负责从网页提取或验证其语义，尚不能凭配置自动产生三项回执。


## 账号 B 迁移

使用私有 Git 仓库迁移 `reception_v2/` 源码与规则，每台电脑独立保存 `.runtime`、浏览器登录态和账号配置。完整步骤见 `reception_v2/README.md` 的“迁移到另一台电脑并切换 B 账号”。
