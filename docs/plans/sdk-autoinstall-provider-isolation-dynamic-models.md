# 方案：SDK 静默自装 / 供应商管理扩展 / 模型动态加载与子代理模型选择

> 状态：设计提案，尚未实施（2026-07-26）。
> 目标：SDK 依赖管理无感化、插件配置完全独立不受外部工具干扰、模型列表动态加载、子代理模型可选。

## 总原则：完全独立、不受外部干扰

插件的运行配置形成一个**自包含的封闭系统**，外部工具（cc-switch、官方 CLI、手改配置文件的 PowerShell 等）做任何改动都**不影响**插件行为：

- **单一事实源**：一切供应商/模型配置以插件私有的 `~/.codemoss/config.json` 为准。
- **运行时隔离**：
  - Codex 侧已实现——托管供应商写到插件私有的隔离 CODEX_HOME（`~/.codemoss/codex-home`，见 `CodexSettingsManager.java:49,58-60`），插件运行时 CODEX_HOME 指向它，真实 `~/.codex` 不被读也不被写（仅用户显式选择「CLI 登录」模式才碰）。
  - Claude 侧已实现大半——托管供应商的凭据/模型按请求经 env 注入，且 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` 让 CLI 剥离 settings.json 里的供应商/模型路由变量（`api-config.js:253-281`）。
- **外部数据只进不出、且只在用户主动触发时进**：cc-switch 等外部配置仅作为「导入来源」被一次性读取（单向快照），插件**不监听、不热同步、不回写**外部文件。
- 用户在外部工具里怎么折腾，插件界面的状态永远不变；要采纳外部改动，只有一个入口：手动「重新导入」。

## 现状梳理（代码事实）

**1. SDK 依赖管理**
- `SdkDefinition.java` 定义两个 SDK：`@anthropic-ai/claude-agent-sdk`、`@openai/codex-sdk`。
- `DependencyManager.java` 在**运行时**通过 npm 把 SDK 装到 `~/.codemoss/dependencies/{claude-sdk,codex-sdk}/node_modules`，带安装/卸载/版本选择/更新检查全套逻辑。
- webview 有完整「SDK 依赖管理」设置页（`get_dependency_status`、`install_dependency` 等消息，`DependencyHandler.java`）。
- ai-bridge 通过 `utils/sdk-loader.js` 从 dependencies 目录加载 SDK；`api-config.js:39` 也从该目录读 manifest 推 CLI 版本。
- `build.gradle:310+` 已会把 ai-bridge 打成 zip 进插件包，但 **node_modules 不打进去**（281 行注释：pre-extracted with node_modules 仅 dev 用）。

**2. 供应商管理**
- 数据存在 `~/.codemoss/config.json`，分 `claude` / `codex` 两节，各有 `providers` + `current`。
- Claude 侧：`ProviderManager.java`；Codex 侧：`CodexSettingsManager.java`——托管模式下写**隔离 CODEX_HOME**（`~/.codemoss/codex-home/config.toml|auth.json`），只有 CLI 登录模式才碰真实 `~/.codex`；隔离 home 的 `sessions/` 软链到真实 `~/.codex/sessions`（共享历史，是有意的唯一桥梁，`CodexSettingsManager.java:110-139`）。
- cc-switch 导入**只有 Claude 侧**：`ProviderManager.parseProvidersFromCcSwitchDb()`（Java 起 Node 跑 `ai-bridge/read-cc-switch-db.js` 读 cc-switch.db）。webview 已有导入 UI 和「cc-switch 配置转为本插件配置」的提示文案（zh.json:559-571）。
- 已有「自定义模型」机制：按供应商存 localStorage（`claude-custom-models` / `codex-custom-models`），合并显示在模型列表最前（`ButtonArea.tsx:118-125`、`providerCapabilities.ts`）。

**3. 模型选择与配置写入**
- 模型列表**硬编码**：`webview/src/components/ChatInputBox/types.ts:315`（CLAUDE_MODELS 5 个）和 `:346`（CODEX_MODELS 9 个）。
- 选择后经 bridge → ai-bridge 写入 env（`ANTHROPIC_MODEL` 等，`api-config.js:127-134`；`CLAUDE_CODE_SUBAGENT_MODEL` 已在受控变量清单里但无 UI）。
- 隔离现状：托管模式下外部工具改 `~/.codex/config.toml` 已**不影响**插件运行（运行时用的是隔离 home）；但 UI 上缺乏明确说明，且 Claude 托管模式仍把磁盘 `~/.claude/settings.json` 作为「高级字段基底」合并（`api-config.js:407-419` 的 `mergeManagedProviderSettings`）——这是仅剩的外部耦合点。

---

## 方案一：SDK 依赖管理 → 首启静默自装 + 后台自动更新（不打进插件包）

思路：**插件包不带 SDK（避免包体积膨胀和 IDEA 加载/内存压力），首次运行自动静默安装到独立目录，之后后台自动更新——全程无 UI、无打扰**。

0. **Node 运行时自举（消灭"用户手动装 Node"）**：首启 `NodeDetector` 找不到可用 Node 时，后台自动下载官方解压版 Node 运行时（约 30MB，zip 解压即用，不需安装器/管理员/改 PATH）到 `~/.codemoss/runtime/node/`；`NodeDetector` 把「插件自备运行时」加为最高优先级候选，ai-bridge 启动和 npm 自装 SDK 统一走它。**完全隔离**：只按绝对路径调用，不写 PATH/注册表/开始菜单；npm 的 cache/prefix 也重定向到 `~/.codemoss` 下（`NPM_CONFIG_CACHE` 等），不在系统任何位置留痕；与用户自己装的 Node 双向不可见——插件不依赖系统 Node，系统 Node 的升级/卸载/多版本切换也影响不到插件。已验证不可行路线：WebView2/JCEF 是浏览器沙箱，无 fs/child_process，Agent SDK 需要 spawn CLI 子进程，无法在 webview 内运行。
1. **首启静默自装**：插件启动时检查 `~/.codemoss/dependencies/{claude-sdk,codex-sdk}`（现有 `DependencyManager.isInstalled()`），缺失则在后台线程自动跑现有的 `installSdkSync()`，版本用 `SdkDefinition` 里钉死的版本。安装中仅在工具窗/状态栏显示一次性进度提示，装完即用；失败提供「重试」通知而非打开设置页。
2. **后台自动更新**：启动时（或每日一次）静默 `checkForUpdates()`，有新版本直接后台 `npm install` 覆盖安装，下次会话生效；失败保留旧版本继续用，永不动阻断流程。
3. **UI 收敛**：删除/隐藏「SDK 依赖管理」设置页及 webview 里对应面板、`DependencyHandler` 的交互消息只保留状态查询；`errorPatterns.json` 里 `openDependencySettings` 的引导改为「自动重试 / 查看日志」。至多保留一个只读版本号显示。
4. **落盘位置不变**：仍存 `~/.codemoss/dependencies/`（独立于 IDE 目录，插件升级不丢、不占 IDEA 内存），`sdk-loader.js` / `api-config.js` 路径逻辑零改动。

代价：首次使用需联网下载（npm registry 不可达时需镜像/代理兜底提示）；相比打包进插件，首启有一段一次性安装等待。

## 方案二：供应商管理 —— cc-switch 导入扩展到 Codex

cc/codex 分栏保留（用户认可），补导入能力：

1. `read-cc-switch-db.js` 目前 `WHERE app_type = 'claude'`（42-45 行）写死；cc-switch（v3.1+）的 db 里同样有 `app_type = 'codex'` 的行。把 app_type 参数化，一次查询返回 `{claude: [...], codex: [...]}`。注意 codex 行的 `settings_config` 结构不同（config.toml 字段如 `model_provider`/`base_url`/`wire_api` + auth.json 的 key），需单独的映射逻辑。
2. `ProviderManager.parseProvidersFromCcSwitchDb()` 抽象出公共解析，新增 Codex 侧解析；或一次解析返回两组由前端分流。
3. webview 导入 UI：在 Codex 供应商页同样加「从 cc-switch 导入」，或统一导入对话框按类型自动归入两个分组。Codex 导入结果映射为 `CodexSettingsManager` 的 provider 结构（写 `~/.codemoss/config.json` 的 codex 节 + 切换时写 config.toml/auth.json）。
4. 沿用现有「cc-switch 配置转为本插件配置」交互：**导入是单向快照，进来即独立**——导入后原 cc-switch 条目与插件配置再无任何关联，外部后续改动一律不可见，除非用户再次手动导入。

## 方案二补：隔离缺口的收口（达成"完全不受干扰"）

1. **Claude 托管模式的磁盘基底**：`mergeManagedProviderSettings` 目前把 `~/.claude/settings.json` 整体当基底再叠托管字段。改为白名单制——托管模式只从磁盘继承明确无害的高级字段（代理/TLS、apiKeyHelper、Bedrock/Vertex/Foundry 开关），其余（model、env 里的路由变量等）一律忽略，外部怎么改 settings.json 都不影响托管会话。
2. **Codex sessions 软链**：隔离 home 的 `sessions/` 目前软链到真实 `~/.codex/sessions`（共享历史）。改为可选设置（默认仍共享，提供「完全隔离」开关），追求彻底隔离的用户可断开。
3. **CLI 登录模式**：是唯一能触及真实 `~/.claude` / `~/.codex` 的路径，属于用户显式选择，UI 上明确标注「此模式与外部 CLI 共享配置，不受插件隔离保护」。

## 方案三：模型动态加载 + 内置化编辑

1. **动态获取**：新增 bridge 消息 `get_available_models`：
   - Codex：从 codex SDK / CLI 拿支持的模型清单（官方支持自定义 `model` 及 `model_providers`，也读 config.toml 里已配置的），拿不到就回退内置列表。
   - Claude：用当前 provider 的 baseUrl + key 调 `GET /v1/models`；失败/超时回退内置列表。
   - Java 侧缓存结果（按 providerId），设置页提供「刷新模型列表」。
2. **列表合成**（前端）：`动态获取 + 内置兜底 + 自定义模型` 三层合并去重，自定义仍排最前。把 `CLAUDE_MODELS`/`CODEX_MODELS` 降级为"内置兜底清单"，新模型靠动态层，不再靠发版改代码。
3. **模型管理 UI**：在供应商编辑对话框的「自定义模型」基础上支持增/删/改/排序/设默认；自定义模型从 localStorage 迁移到 `~/.codemoss/config.json` 的 provider 条目里（跟着供应商走，导出导入不丢）。
4. **编辑内置化**：所有配置修改只走 `ClaudeSettingsManager` / `CodexSettingsManager`（`writeConfigToml` / `writeAuthJson` / `applyProviderToCodexSettings`，写入的都是插件隔离目录），写盘后同步更新 `~/.codemoss/config.json`，保证单一事实源。外部工具（cc-switch、手改 PowerShell）的改动插件**不监听、不合并**，只在用户主动「重新导入」时读取——配合「总原则」，UI 上明确提示"插件配置独立运行，不受外部工具影响"。

## 方案四：子代理模型选择（类 Cursor）

1. Claude 侧：利用已预留的 `CLAUDE_CODE_SUBAGENT_MODEL`（`api-config.js:133` 已在 webview 受控 env 清单），在设置或输入区加「子代理模型」选择器，**复用方案三的动态模型列表**，每请求随 env 下发；可选进一步支持 per-agent 覆盖（写 `.claude/agents/*.md` frontmatter 的 `model` 字段，也是内置写入方式）。
2. Codex 侧：Codex 无对应子代理概念，该选择器仅 Claude 分组显示（与现有 effort/plan mode 按 providerCapabilities 分组的模式一致）。

---

## 实施顺序建议

1. 方案一（SDK 静默自装）——独立性最强，先解决"恶心"的最大来源。
2. 方案二补（隔离收口）——改动小、直接达成"完全不受干扰"的目标。
3. 方案三（模型动态加载）——用户感知最强，且方案四依赖它的模型列表。
4. 方案二（cc-switch codex 导入）——增量功能。
5. 方案四（子代理模型）——最后做，依附于三。

## 遗留问题 / 实施期需验证

1. **Codex 模型动态获取可行性**（方案三最大不确定点）：`@openai/codex-sdk` 是否暴露模型列表 API 需先验证；若不可行，备选 = config.toml 的 `model`/`model_providers` + 内置列表 + 自定义模型。
2. 动态拿到的新模型缺少 effort/上下文窗口/定价元数据，需"未知模型按默认可用处理"的降级策略。
3. 自定义模型从 localStorage 迁移到 config.json 时需带老用户数据迁移。
4. per-agent 模型覆盖要写项目内 `.claude/agents/*.md`，与隔离原则有张力——建议只做全局子代理模型选择（env 注入，零文件写入）。
5. Node/npm 下载源的国内可达性：镜像兜底（npmmirror / npm 镜像配置）。

## 风险点

- 首启自装依赖下载可达：Node 运行时来自 nodejs.org（需镜像兜底，如 npmmirror）、SDK 来自 npm registry；离线/内网环境需要镜像配置或手动放置兜底（检测 `~/.codemoss/runtime/` 下已有目录则直接用）。
- Node 自举需按平台选包（win-x64/mac-x64/mac-arm64/linux），并处理解压权限与杀毒软件误报。
- 静默更新失败必须永远保留旧版本可用（安装不破坏现有目录，失败即弃）。
- `/v1/models` 不是所有 Anthropic 兼容供应商都实现，需兜底。
- cc-switch.db 结构是第三方格式，解析逻辑需随 cc-switch 版本演进维护。
- Claude 托管模式改白名单基底时，需确认只影响 managed 模式，`__local_settings_json__` / `__cli_login__` 模式行为不变，避免破坏现有用户的高级配置。
