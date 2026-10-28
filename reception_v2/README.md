# Reception V2

独立的真人感小红书接待进程。旧 `xhs_reception` 服务和数据库保持停止、只读。

## 前置

- Node.js 24 或更高。
- 通过 `XHS_PLAYWRIGHT_MODULE` 指向已有 Playwright 的绝对入口。
- `reception_v2/config/business-facts.json` 必须由用户审核并设置 `approved: true`。

## 命令

```sh
node reception_v2/main.mjs account
node reception_v2/main.mjs login
node reception_v2/main.mjs doctor --no-browser
node reception_v2/main.mjs status
node reception_v2/main.mjs stop
XHS_PLAYWRIGHT_MODULE=/已有/playwright/index.js node reception_v2/main.mjs run
XHS_PLAYWRIGHT_MODULE=/已有/playwright/index.js node reception_v2/main.mjs run --arm --pilot-one
XHS_PLAYWRIGHT_MODULE=/已有/playwright/index.js reception_v2/launch-reception-v2.sh
```

`login` 只打开项目隔离浏览器并等待指定账号标题出现，不启动接待、不发送消息。不带 `--arm` 的运行模式只读取页面，不发送。`--arm --pilot-one` 只处理一位可见超时客户，然后关闭浏览器、释放锁并退出，不进入持续轮询。`launch-reception-v2.sh` 会原样转发附加参数，例如 `--pilot-one`；通知器只由 `main.mjs` 启动和管理。

## 持续运行

生产运行由 `~/Library/LaunchAgents/com.chatcut.reception-v2.plist` 管理。该 LaunchAgent 在工作区直接执行 Node，不在“文稿”目录里再套一层 shell，因此不会触发额外的文件夹执行权限问题；`RunAtLoad` 负责登录后启动，`KeepAlive` 负责异常退出后拉起。

```sh
launchctl print gui/$(id -u)/com.chatcut.reception-v2
node reception_v2/main.mjs status
```

状态必须同时满足锁所有者存在、`running=true`、`error=null`，并且 `last_tick_at_utc` 或 `last_successful_sidebar_read_at` 持续递进。仅凭进程存在不能判定接待成功。

## 文件

- `.runtime/reception-v2.sqlite3`：接待回合、消息、发送 Intent、联系方法。
- `.runtime/reception-v2-health.json`：250 毫秒轮询健康状态；`status` 会核对锁与进程启动身份，过期健康不会被报告为运行中。
- `.runtime/reception-v2-notification-queue.json`：三张业务卡片。
- `.runtime/reception-v2.lock`：单实例 PID 锁。
- `.runtime/isolated-browser-profile`：专用隔离登录资料，不与日常浏览器共用。

## 业务卡片

普通聊天不通知。只有以下三种：

- `可以跟进`：拿到企微、手机号、微信号或平台留资。
- `需要你处理`：客户要求人工、资料不足、发现疑似联系方式但尚未确认，或连续无法取得联系。
- `消息没有发出去`：平台明确限制或无法确认发送；详情提示可能已经发出，禁止手动重发。

## 安全规则

- 同一客户 800 毫秒内的消息合并成一次接待。
- 同一内容在一个客户会话内绝不重复提交。
- 同一客户的同一联系方式结果只生成一次跟进卡片；即使卡片已经确认，也不会每秒重复刷出。
- 弹窗点击“知道了”后会先在本机排除该卡片，等待后台保存确认；最后一张不会因 250 毫秒确认延迟重新出现。
- 正常停机或热更新期间，浏览器关闭错误只记录在健康状态，不会生成“客户自动接待失败”的假卡片。
- 用户弹窗只显示成功的“可以跟进”卡；接管失败、发送待核实等动作事件写入隐藏诊断文件，不进入成功通知队列。
- 人工接管失败会在同一轮静默重试 3 次，仍失败则保留在后台队列，2 秒后继续重试，不反复打扰用户。
- 发送后 2 秒没有严格回执时，会重新打开同一 UID 的原生会话并再核验最多 2 次；三次都不匹配才进入待核实，全程不重复发送。
- 多次回查确认服务器历史缺失后，才允许创建有界替代重试；任意新重试成功后才将旧意图标为已确认缺失。
- 平台显示“留资客”时仍会读取手机号、微信号或已加企微；读取到明确联系方式时优先推送明确值，无法读取时才使用“已提交留资卡”作为兜底。
- `business-facts.json` 中的 `unsupported_regions` 会触发明确拒答；例如日本必须直说“目前不做”，不能回复“需要确认”。
- 报价、转运、联系我们或其他明确需求优先直接回复“加我企微，客服小姐姐会具体回答您”，并同时发企微卡；不再回复“我帮你确认/核实”。
- “加过、加过了、已经加过了”属于已添加企微的终态，立即停止获客动作，不再发邀请或企微卡。
- 启动扫描会对今天和昨天的近期会话检查平台 AI 状态，发现“人工接管”按钮时只切换模式，不自动追发历史消息。
- 文字和企微卡分别核验当前账号、UID、类型、内容和平台毫秒时间。
- 每次发送只接受由本次按钮点击对应 request 返回、查询 UID 与响应业务码一致的最终消息。
- 客户拒绝、拿到联系方式或平台限制后停止获客动作。
- 未确认的手机号或疑似微信号只推给用户核对，不标记留资，也不停止客户接待。
- 完整联系方式只进入 0600 本地状态和给用户的业务卡片，不写普通日志。

## 只读验收

```sh
XHS_PLAYWRIGHT_MODULE=/已有/playwright/index.js node reception_v2/test/live-smoke.mjs --read-only
XHS_PLAYWRIGHT_MODULE=/已有/playwright/index.js node reception_v2/test/live-readonly-panel.mjs
XHS_PLAYWRIGHT_MODULE=/已有/playwright/index.js node reception_v2/test/live-observation.mjs
```

三个命令都不得发送客户消息。最后一个会写出 `.runtime/reception-v2-readonly-observation.json`，只保存选区、联系方式种类和控件数量，不保存客户原话或完整联系方式。


## 迁移到另一台电脑并切换 B 账号

迁移时用 Git 同步程序，账号运行数据必须在每台电脑上重新生成。不要把 A 的 `.runtime`、浏览器登录目录、SQLite、通知队列、日志或字段中的客户资料复制给 B。

### Git 应该保存什么

- `reception_v2/` 中的源码、测试、通用业务规则和部署脚本。
- `reception_v2/config/account.example.json`。
- 已审核且可跨账号复用的 `reception_v2/config/business-facts.json`。

### Git 不应保存什么

- `.runtime/`、`.runtime-*/`。
- `reception_v2/config/account.local.json`。
- `isolated-browser-profile`、Cookie、local storage、账号登录态。
- `*.sqlite3`、客户昵称、客户原话、手机号、微信号、审计和通知回执。
- LaunchAgent 的本机绝对路径、PID、锁文件和日志。

### 在 A 电脑提交并推送

先使用私有 Git 仓库；不要在公开仓库里放账号配置或运行数据。

```sh
git add .
git commit -m "Add portable multi-account reception workflow"
git remote add origin <你的私有仓库地址>
git push -u origin main
```

### 在 B 电脑准备代码

```sh
git clone <你的私有仓库地址> Chat-cut
cd Chat-cut
node --version
# 必须为 24 或更高
```

准备 Playwright 后设置绝对入口：

```sh
export XHS_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.js
```

### 只在本机创建 B 账号配置

```sh
cp reception_v2/config/account.example.json reception_v2/config/account.local.json
chmod 600 reception_v2/config/account.local.json
```

把下面字段换成 B 的真实值，不能猜，也不能沿用 A：

- `accountId`：B 的 24 位小写十六进制 UID。
- `accountName`：B 在私信通标题中的完整显示名。
- `runtimeDir`：B 的独立目录，例如 `.runtime-b`。
- `card.title`：B 原生名片面板中的完整 `title`。
- `card.visibleName`：B 原生卡片可见名称。
- `card.id`：B 原生 `COMMERCIAL_BUSINESS_CARD` 的 `id`。
- `card.csaAccountNo`：B 原生卡片 `csaAccountNo`。
- `card.corpName`：B 原生卡片 `corpName`。

配置不完整、UID 格式错误，或者 B 想静默继承 A 的企微卡时，程序会直接失败。这是为了防止把 A 的客户名片发给 B 的客户。

检查最终解析结果：

```sh
node reception_v2/main.mjs account
```

### 登录 B，不启动回复

```sh
node reception_v2/main.mjs login
```

命令会打开项目专用隔离浏览器。登录 B，直到页面标题被识别为 B 的完整标题；命令随后退出。整个过程不武装接待、不发送消息。A 的登录目录不会参与。

### 建库、通知器和健康检查

B 的第一次运行会在自己的 `runtimeDir` 中建立空数据库和浏览器目录。通知器需要在本机编译一次：

```sh
runtime_dir=$(node reception_v2/main.mjs account | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).runtimeDir))")
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
xcrun swiftc reception_v2/NotifierApp.swift reception_v2/NotifierQueue.swift -o "$runtime_dir/reception-v2-notifier"
chmod 700 "$runtime_dir/reception-v2-notifier"
node reception_v2/main.mjs doctor --no-browser
```

### 先只读，再试点，最后常驻

```sh
XHS_PLAYWRIGHT_MODULE="$XHS_PLAYWRIGHT_MODULE" node reception_v2/test/live-smoke.mjs --read-only
XHS_PLAYWRIGHT_MODULE="$XHS_PLAYWRIGHT_MODULE" node reception_v2/test/live-readonly-panel.mjs
XHS_PLAYWRIGHT_MODULE="$XHS_PLAYWRIGHT_MODULE" node reception_v2/test/live-observation.mjs
XHS_PLAYWRIGHT_MODULE="$XHS_PLAYWRIGHT_MODULE" node reception_v2/main.mjs run --arm --pilot-one
```

`live-smoke`、`live-readonly-panel`、`live-observation` 都不发送消息。`--pilot-one` 只处理一位可见超时客户然后退出；检查严格文字与企微卡历史回执、通知卡和客户后续回复，再进入持续运行。

### 安装 B 专用 LaunchAgent

A 和 B 即使以后在同一台电脑，也必须使用不同 Label、runtime、浏览器目录、数据库、锁和通知进程。

```sh
XHS_PLAYWRIGHT_MODULE="$XHS_PLAYWRIGHT_MODULE" \
node reception_v2/create-launch-agent.mjs \
  --label com.chatcut.reception-v2.<B唯一后缀> \
  --write

plutil -lint "$HOME/Library/LaunchAgents/com.chatcut.reception-v2.<B唯一后缀>.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.chatcut.reception-v2.<B唯一后缀>.plist"
```

验证是否能长期工作，只看 `status` 的 `last_tick_at_utc` 和 `last_successful_sidebar_read_at` 是否递进、`error` 是否为 `null`；进程活着本身不算接待成功。

### 当前“无损”边界

可以无损迁移源码、测试、话术、业务规则、严格回执逻辑和部署方式。不能迁移 A 的登录态与客户数据。B 首次上线必须用一次真实进线完成新账号的原生标题、UID、企微卡和消息回执验收；未完成前不能说 B 已无损接管。
