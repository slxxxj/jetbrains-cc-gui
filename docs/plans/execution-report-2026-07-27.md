# 执行报告：SDK 静默化 / 配置隔离 / 模型动态加载 / cc-switch 导入 / 子代理模型

> 执行时间：2026-07-26 ~ 27。对应方案文档：`docs/plans/sdk-autoinstall-provider-isolation-dynamic-models.md`。
> 全部 5 个 Phase 完成。未做任何 git 写操作，所有改动在工作区与你未提交的修复并存。

## 验证总览

| 范围 | 结果 |
|---|---|
| Java 全量 `gradlew test -PskipWebview=true` | **BUILD SUCCESSFUL**（123 suite / 833 测试，0 失败） |
| webview `npm test` 全量 | **836 测试全过**，tsc 主+test 配置 exit 0，`npm run build` exit 0 |
| ai-bridge `node --test ai-bridge/`（仓库根执行） | 302/317；**15 个失败全部是工作区既有 WIP 的失败**（persistent-query-service 的 perpetual-reader 竞态 14 个 + codex-event-handler 1 个），经对照实验（回退本次改动复跑）证明与本次无关 |
| `api-config.test.js` | 27/27（此前"24 失败"是我从 `ai-bridge/` 子目录运行导致的 cwd 假相——测试按仓库根拼路径，非真实问题） |
| 端到端冒烟 | `codex debug models` 动态模型列表真实返回 `source:"dynamic"`，缓存命中正常 |

## Phase 1 · SDK 依赖管理 → 静默自动化

- **Node 运行时自举**：新增 `runtime/NodeRuntimeManager.java`（钉死 Node 22.14.0 LTS，官方 dist/npmmirror 双源，分平台 zip/tar.gz，纯 Java 解压器 `NodeArchiveExtractor` 带 ZipSlip 防护，半成品清理，旧运行时永不被破坏）。`NodeDetector` 新增最高优先级 `PLUGIN_MANAGED` 探测；探测失败自动后台下载（约 30MB 到 `~/.codemoss/runtime/node/`，不写 PATH/注册表）。手动配置的 node 路径优先级仍最高。24 个单测。
- **SDK 静默安装/更新**：新增 `dependency/SdkAutoInstallService.java` + `startup/SdkAutoInstallActivity.java`（plugin.xml 注册）。首启缺 SDK 后台自动装（状态栏一次性进度，失败一条带「重试」的通知）；24h 节流静默更新，失败保留旧版；多窗口幂等。已对接 `NodeRuntimeManager.ensureRuntime()`。16 个单测。
- **UI 收敛**：`DependencySection` 重写为只读面板（名称/版本/状态徽章/路径）；`DependencyHandler` 617→256 行只留状态查询；`errorPatterns.json` 移除 `openDependencySettings` 引导；10 语言文案就位。webview 794 测试 + build 过。

## Phase 2 · 配置隔离收口

- **Claude 白名单基底**：`api-config.js` 的 `mergeManagedProviderSettings` 重写——managed 模式不再以磁盘 settings.json 整体为基底，只继承白名单（apiKeyHelper、代理/TLS、AWS 凭据、Bedrock/Vertex/Foundry 开关）；local/cli_login 模式行为不变。api-config 测试 26/26（现 27/27）。
- **Codex sessions 隔离开关**：`codex.isolateSessions`（默认 false 共享历史；true 完全隔离不建软链，绝不删已有数据）。存储+逻辑完成，**UI 入口留 TODO 未接**（避免与并行任务冲突）。7 个隔离测试。
- **CLI 登录标注**：Claude/Codex 两个供应商区均加「此模式与外部 CLI 共享配置，不受插件隔离保护」，10 语言。

## Phase 3 · 模型动态加载

- **后端**：新增 `ai-bridge/services/model-list-service.js`——Codex 走 vendor 二进制 `codex debug models`（过滤 visibility=list、priority 排序，含用户自定义目录）；Claude 走 `GET {baseUrl}/v1/models`（5s 超时，仅 api_key/auth_token）；10 分钟缓存。Java 新增 `AvailableModelsHandler`（`get_available_models` → `window.updateAvailableModels`，45s 超时必回 fallback）。冒烟通过。
- **前端**：新增 `availableModelsStore` + `useAvailableModels` + `providerCustomModelsStore`；模型列表 = 自定义（最前）∪ 动态 ∪ 内置兜底（原硬编码清单降级为兜底）；`ModelSelect` 加「刷新模型列表」行；customModels 从 localStorage 迁到 provider 条目（确认回显后才清 localStorage，迁移失败零丢失）；未知模型 id 不再被启动恢复逻辑误杀。
- **注意**：provider 条目的 `customModels` 字段经 3A 验证全链路 JsonObject 透传，零拦截。

## Phase 4 · cc-switch 导入扩展到 Codex

- `read-cc-switch-db.js` app_type 参数化（`claude|codex|all`，默认 claude 逐字节兼容旧输出）；codex 的 settings_config 格式已对照 cc-switch 上游源码核实（`{auth, config:<TOML原文>}`）。
- Java：`parseCodexProvidersFromCcSwitchDb` + 映射纯函数；`ProviderImportExportSupport` 统一 Claude/Codex 两条导入链路（独立回调 `codex_import_preview_result` 防互踩）。
- webview：CodexProviderSection 补齐与 Claude 同款导入交互（默认路径/选文件 → 预览 → 保存），含 badge、编辑警告、「转换为插件配置」。导入即独立（单向快照）。
- 验证：Java 833、webview 825、ai-bridge 27/27。

## Phase 5 · 子代理模型选择（Claude）

- 链路镜像 reasoningEffort：webview `SubagentModelSelect`（ButtonArea 内，仅 Claude 显示，选项与主模型同源动态列表，首项「默认（跟随主模型）」）→ localStorage 持久化 → `send_message` 载荷 `subagentModel`（仅非空才带）→ Java 全链透传（`ProviderSendRequest.subagentModel`，旧调用方零改动）→ ai-bridge 每请求设置 `CLAUDE_CODE_SUBAGENT_MODEL`，未选时 delete + settings override 中和，无残留。
- 已知代价：切换子代理模型会触发一次 runtime 重建（与 [1m] 切换同语义，正确性必需）；Java prewarm 不带 subagentModel（预热后首条带选择会多一次重建，有意最小 diff）。

## 遗留事项（按优先级）

1. **ai-bridge 15 个既有测试失败**：`persistent-query-service*.test.mjs`（perpetual-reader "Runtime is closed" 竞态）+ `codex-event-handler.test.js`——均在你未提交的 WIP 文件里，与本次改动无关，建议在你的修复分支里跟进。
2. **存量 bug（本次发现未修）**：`webview/src/hooks/windowCallbacks/registerCallbacks/usageModeCallbacks.ts:108` 直接赋值 `window.updateActiveProvider`，覆盖了 runtimeProviderCapabilities 的 dispatcher，导致 Claude 侧 `subscribeActiveProvider` 在生产失效（RuntimeProviderSelect 同步受影响）。建议改为链式调用。
3. **Codex 隔离开关 UI 未接**：`codex.isolateSessions` 只有存储+逻辑，需加 webview 设置项（代码内 TODO）。
4. **Node 运行时未做真实下载联调**：URL 布局按 nodejs.org/npmmirror 标准约定，单测全桩；建议首次真机验证 win-x64 下载链路。
5. **checkstyle 本机跑不了**：JDK 21 vs toolchain 17 的环境问题（预先存在）；改动文件已用 checkstyle 10.12.5 CLI 单独验证 0 违规。
6. 存量共享 sessions 软链在开启隔离后不会自动拆除（仅 warn），如需"一键断开"后续再加。

## 关键文件索引

- Node 自举：`runtime/NodeRuntimeManager.java`、`runtime/NodeArchiveExtractor.java`、`bridge/NodeDetector.java`
- SDK 静默：`dependency/SdkAutoInstallService.java`、`startup/SdkAutoInstallActivity.java`、`handler/DependencyHandler.java`
- 隔离：`ai-bridge/config/api-config.js`（白名单）、`settings/CodexSettingsManager.java` + `CodemossSettingsService.java`（isolateSessions）
- 模型动态：`ai-bridge/services/model-list-service.js`、`handler/AvailableModelsHandler.java`、`webview/src/utils/availableModelsStore.ts`、`webview/src/hooks/useAvailableModels.ts`
- cc-switch：`ai-bridge/read-cc-switch-db.js`、`settings/ProviderManager.java`、`handler/provider/ProviderImportExportSupport.java`
- 子代理模型：`webview/src/components/ChatInputBox/selectors/SubagentModelSelect.tsx`、`provider/common/ProviderSendRequest.java`、`ai-bridge/services/claude/persistent-query-service.js`
