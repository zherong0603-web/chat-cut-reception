# B 电脑部署：只做两步

## 第 1 步：把仓库克隆到 B 电脑

```sh
git clone <PRIVATE_REPOSITORY_URL> Chat-cut
```

## 第 2 步：用 Codex 打开 `Chat-cut`，原样粘贴

```text
读取 BOOTSTRAP_B.md，从头到尾替我在本机部署 B 账号接待。
你是执行者：自行检查环境、配置、编译、测试、只读验证和后台服务；需要我登录小红书时再告诉我，不要让我抄命令。
不要使用日常 Chrome，不要复制 A 的 .runtime，不要猜 B 的 UID 或企微卡信息，未完成严格原生回执前不要正式接待。
一直做到 B 账号只读验收和一位客户的真实试点完成，并把最终状态告诉我。
```

---

# 给 Codex 的执行清单

## 目标和边界

目标是在当前 B 电脑上完成独立账号接待：

1. 代码来自本 Git 仓库。
2. B 账号使用自己的 `.runtime-b`、浏览器登录目录、SQLite、通知队列、锁和 LaunchAgent。
3. 不复制 A 电脑的 `.runtime`、Cookie、客户数据、数据库、日志、PID 或通知状态。
4. 不控制日常 Chrome、用户鼠标、键盘、焦点或桌面空间。只操作项目隔离浏览器。
5. 未经严格回执核验，不能声称文字或企微卡发送成功。
6. 真实进线试点完成前，不能声称 B 已无损上线。

## 1. 先读现有实现

依次阅读：

- `AGENTS.md`
- `reception_v2/README.md`
- `reception_v2/account-config.mjs`
- `reception_v2/config/account.example.json`
- `reception_v2/main.mjs`
- `reception_v2/launch-reception-v2.sh`
- `reception_v2/create-launch-agent.mjs`

不要重做平行系统，复用这些组件。

## 2. 检查运行环境

检查并准备：

- Node.js 24 或更高。
- Playwright 的绝对入口。
- macOS `swiftc`，用于编译通知器。
- Git 账号对私有仓库的读取权限。

如果 Node 或 Playwright 不在 PATH，可搜索 Codex 自带的运行时。不要把路径写回已跟踪源码；通过环境变量或 B 本机配置传入。

## 3. 创建 B 本地配置

```sh
cp reception_v2/config/account.example.json reception_v2/config/account.local.json
chmod 600 reception_v2/config/account.local.json
```

`account.local.json` 已被 Git 忽略，只存在 B 本机。

必须取得 B 的真实值：

- `accountId`：B 的 24 位小写十六进制 UID。
- `accountName`：B 私信通页面标题中的完整账号名。
- `runtimeDir`：例如 `.runtime-b`。
- `card.title`
- `card.visibleName`
- `card.id`
- `card.csaAccountNo`
- `card.corpName`

企微卡字段必须来自 B 的原生名片数据和原生消息结构。不能沿用 A 的卡片，不能根据显示文字猜 ID。

若暂时无法取得完整卡片元数据，保留 `BLOCKED_BY_HUMAN` 或继续只读诊断；不得先武装发送。

## 4. 登录 B

```sh
node reception_v2/main.mjs login
```

打开的是项目隔离浏览器。请用户登录 B，直到命令识别到 B 的完整官方标题并退出。此命令不启动接待、不发送消息。

登录后检查：

```sh
node reception_v2/main.mjs account
```

确认解析出的 UID、名称、runtime、企微卡和 facts 路径全部属于 B。

## 5. 建立 B 专属运行目录和通知器

从 `account` 输出取得 `runtimeDir`，然后：

```sh
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
xcrun swiftc reception_v2/NotifierApp.swift reception_v2/NotifierQueue.swift -o "$runtime_dir/reception-v2-notifier"
chmod 700 "$runtime_dir/reception-v2-notifier"
node reception_v2/main.mjs doctor --no-browser
```

## 6. 跑离线测试

```sh
node --test reception_v2/test/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
XHS_ENGINE_TEST_PYTHON=/usr/bin/python3 node --test tests/test_*.cjs
```

有失败就先修复并复测。不能用计划、测试数量或进程存活代替真实接待结果。

## 7. 只读验收

```sh
XHS_PLAYWRIGHT_MODULE="$XHS_PLAYWRIGHT_MODULE" node reception_v2/test/live-smoke.mjs --read-only
XHS_PLAYWRIGHT_MODULE="$XHS_PLAYWRIGHT_MODULE" node reception_v2/test/live-readonly-panel.mjs
XHS_PLAYWRIGHT_MODULE="$XHS_PLAYWRIGHT_MODULE" node reception_v2/test/live-observation.mjs
```

确认：

- B 标题、账号 UID、客户 UID 和 profile 配对正确。
- `全部会话` 和 `Total-UID` 行可见。
- 原生文字、企微卡面板、接管按钮和联系资料可以只读识别。
- `sends_performed=0`。

## 8. 一位客户真实试点

```sh
XHS_PLAYWRIGHT_MODULE="$XHS_PLAYWRIGHT_MODULE" node reception_v2/main.mjs run --arm --pilot-one
```

只处理一位可见超时客户，然后退出。必须分别核验：

- 客户原话和原平台时间。
- 自动人工接管是否成功。
- 本轮具体文字的原生服务器严格回执。
- B 企微卡的账号、UID、类型、内容、卡片身份和服务器时间。
- 客户后续回复、拒绝、联系方式或加企微终态。
- 从 B 进线原平台时间算起的完整耗时。

任何文字或卡片结果不明确时保留待核实，不重复发送。

## 9. 安装 B 专属后台服务

试点通过后：

```sh
XHS_PLAYWRIGHT_MODULE="$XHS_PLAYWRIGHT_MODULE" \
node reception_v2/create-launch-agent.mjs \
  --label com.chatcut.reception-v2.b \
  --write

plutil -lint "$HOME/Library/LaunchAgents/com.chatcut.reception-v2.b.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.chatcut.reception-v2.b.plist"
```

核验 `node reception_v2/main.mjs status`：

- `running=true`
- `error=null`
- `stale_health=false`
- `last_tick_at_utc` 持续递进
- `last_successful_sidebar_read_at` 持续递进

进程活着本身不算接待成功。

## 最终交付给用户

只报告四项：

1. B 是否已经登录并配置正确。
2. 只读验收和一个客户试点的真实结果。
3. 文字和企微卡是否得到严格回执；失败的下一步是什么。
4. B 专属后台服务是否已启动，以及当前健康状态。
