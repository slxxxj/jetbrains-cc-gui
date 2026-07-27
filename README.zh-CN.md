<div align="center">

# CodeAide（Claude or Codex）

> 基于开源项目 [CC GUI](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) 二次开发 —— 已全面更名，MIT 协议。

<img width="120" alt="CodeAide Logo" src="./docs/images/codeaide-logo.png" />

**简体中文** · [English](./README.md)

</div>

**CodeAide** 是一个功能强大的 JetBrains IDE 插件，为开发者提供 **Claude Code** 和 **OpenAI Codex** 双 AI 工具的可视化操作界面，让 AI 辅助编程变得更加高效和直观。

本项目基于开源项目 [CC GUI](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui)（原名 `idea-claude-code-gui`，MIT 协议）二次开发，已完成整体更名，与原插件不再有任何标识冲突：

- 新插件 id：`com.codeaide`（原 `com.github.idea-claude-code-gui`）
- 新 Java 包名：`com.codeaide`（原 `com.github.claudecodegui`）
- 新工具窗口 id `CodeAide`，新 Action 前缀 `CodeAide.*`
- 新资源包：`messages.CodeAideBundle`，新图标 `codeaide-icon.svg`
- 新用户数据目录：`~/.codeaide`（原 `~/.codemoss`），可与原插件并存安装、互不影响

原作者及所有贡献者保留全部荣誉，在此致谢。

<img width="850" alt="Image" src="/docs/img/banner.png" />

---

## CodeAide 特色增强

站在 CC GUI 这个优秀项目的肩膀上，CodeAide 在它的基础上继续打磨，带来了这些新变化：

- **⚡ 快捷指令** —— 聊天输入框工具栏的一键指令面板：解释代码、修复 Bug、编写测试、代码重构、性能优化、代码审查、编写文档、添加注释，中英双语，自动填入输入框即可发送；还能把当前输入保存为自己的常用指令（本地持久化），随用随取
- **🎨 全新品牌与高级图标** —— 靛蓝-紫渐变「A + AI 星标」，覆盖工具窗口、插件图标、状态栏与文档
- **🔴 不打扰的更新提醒** —— 版本更新不再强制弹窗，改为版本号标签上的未读红点，看过即消
- **🧩 并存安装** —— 独立的插件 id 与数据目录（`~/.codeaide`），可与原插件同时安装、互不影响

## 核心特性

### 双 AI 引擎支持
- **Claude Code** - Anthropic 官方 AI 编程助手，支持 Opus 4.5 等多模型
- **OpenAI Codex** - OpenAI 强大的代码生成引擎

### 智能对话功能
- 上下文感知的 AI 编程助手
- 支持 @文件引用，精准指定代码上下文
- 图片发送支持，可视化描述需求
- 对话回退功能，灵活调整对话历史
- 强化提示词，优化 AI 理解能力

### Agent 智能体
- 内置 Agent 系统，自动化执行复杂任务
- Skills 斜杠命令系统（/init, /review 等）
- MCP 服务器支持，扩展 AI 能力边界

### 开发者体验
- 完善的权限管理和安全控制
- 代码 DIFF 对比功能
- 文件跳转和代码导航
- 深色/浅色主题切换
- 字体缩放和 IDE 字体同步
- 国际化支持（10 种语言）

### 会话管理
- 历史会话记录和搜索
- 会话收藏功能
- 消息导出支持
- 供应商管理（兼容 cc-switch）
- 使用统计分析

---

## 项目状态

项目处于积极开发阶段，持续更新中。版本历史和迭代进度请阅读 [CHANGELOG.md](CHANGELOG.md)

---

## 本地开发调试

### 1. 安装前端依赖

```bash
cd webview
npm install
```

### 2. 安装 ai-bridge 依赖

```bash
cd ai-bridge
npm install
```

### 3. 调试插件

在 IDEA 中运行：
```bash
./gradlew clean runIde
```

### 4. 构建插件

```sh
./gradlew clean buildPlugin

# 生成的插件包在 build/distributions/ 目录下
```

---

## 贡献

贡献指南请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 致谢

- 上游项目：[zhukunpenglinyutong/jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui)（CC GUI，原名 Claude Code GUI）及其全体贡献者。

---

## License

MIT（见 [LICENSE](LICENSE)）
