// One-off: add subagent-live + runningTool i18n keys to en/zh/zh-TW locales.
// Idempotent: existing keys are left untouched.
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales');

const KEYS = {
  'en.json': {
    chat: { runningTool: 'Running {{toolName}}' },
    subagent: {
      live: {
        starting: 'Subagent starting',
        runningTool: 'Running {{toolName}}',
        toolCount_one: '{{count}} tool call',
        toolCount_other: '{{count}} tool calls',
        statusCompleted: 'Completed',
        statusError: 'Failed',
        statusStopped: 'Stopped',
        stepsTitle: 'Steps',
      },
    },
  },
  'zh.json': {
    chat: { runningTool: '正在执行 {{toolName}}' },
    subagent: {
      live: {
        starting: '子代理启动中',
        runningTool: '正在执行 {{toolName}}',
        toolCount_one: '{{count}} 次工具调用',
        toolCount_other: '{{count}} 次工具调用',
        statusCompleted: '已完成',
        statusError: '失败',
        statusStopped: '已停止',
        stepsTitle: '执行步骤',
      },
    },
  },
  'zh-TW.json': {
    chat: { runningTool: '正在執行 {{toolName}}' },
    subagent: {
      live: {
        starting: '子代理啟動中',
        runningTool: '正在執行 {{toolName}}',
        toolCount_one: '{{count}} 次工具調用',
        toolCount_other: '{{count}} 次工具調用',
        statusCompleted: '已完成',
        statusError: '失敗',
        statusStopped: '已停止',
        stepsTitle: '執行步驟',
      },
    },
  },
};

function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = mergeDeep(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
    } else if (target[key] === undefined) {
      target[key] = value;
    }
  }
  return target;
}

for (const [file, keys] of Object.entries(KEYS)) {
  const filePath = path.join(LOCALES_DIR, file);
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  mergeDeep(json, keys);
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`updated ${file}`);
}
