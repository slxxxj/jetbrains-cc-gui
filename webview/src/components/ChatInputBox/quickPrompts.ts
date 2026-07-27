/**
 * Quick Prompts - one-click preset instructions for the chat input box.
 *
 * A visible quick-action panel of polished
 * scenario prompts, so users do not have to type /skills or remember
 * slash command names. Labels and prompt bodies are bilingual (zh/en);
 * other UI languages fall back to English.
 */

export interface QuickPrompt {
  id: string;
  icon: string;
  labelEn: string;
  labelZh: string;
  descEn: string;
  descZh: string;
  promptEn: string;
  promptZh: string;
}

export const QUICK_PROMPTS: QuickPrompt[] = [
  {
    id: 'explain',
    icon: 'codicon-book',
    labelEn: 'Explain Code',
    labelZh: '解释代码',
    descEn: 'What it does, core logic, potential issues',
    descZh: '功能、核心逻辑与潜在问题',
    promptEn:
      'Explain the selected code: what it does, its core logic step by step, key details worth knowing, and any potential issues you spot.',
    promptZh:
      '解释选中的代码：它的功能、核心逻辑（分步骤）、值得注意的关键细节，以及你发现的潜在问题。',
  },
  {
    id: 'fixbug',
    icon: 'codicon-bug',
    labelEn: 'Find & Fix Bug',
    labelZh: '修复 Bug',
    descEn: 'Locate the root cause and fix it directly',
    descZh: '定位根因并直接修复',
    promptEn:
      'Analyze the selected code for possible bugs. For each one: explain the root cause, then apply the fix directly and briefly summarize what you changed.',
    promptZh:
      '分析选中代码中可能存在的 Bug：逐个说明根本原因，然后直接修改代码修复，并简要总结改动内容。',
  },
  {
    id: 'test',
    icon: 'codicon-beaker',
    labelEn: 'Write Tests',
    labelZh: '编写测试',
    descEn: 'Unit tests covering edge cases',
    descZh: '覆盖边界条件的单元测试',
    promptEn:
      'Write comprehensive unit tests for the selected code, covering the happy path, boundary conditions, and error cases. Follow the test framework and style already used in this project.',
    promptZh:
      '为选中的代码编写全面的单元测试，覆盖正常路径、边界条件和异常情况，并遵循本项目已有的测试框架与风格。',
  },
  {
    id: 'refactor',
    icon: 'codicon-wand',
    labelEn: 'Refactor',
    labelZh: '代码重构',
    descEn: 'Cleaner structure, same behavior',
    descZh: '行为不变，结构更清晰',
    promptEn:
      'Refactor the selected code to improve readability and maintainability: remove duplication, clarify naming, and simplify structure — without changing behavior. Explain the reason for each change.',
    promptZh:
      '重构选中的代码：消除重复、优化命名、简化结构，提升可读性与可维护性，同时保持行为完全不变，并说明每处改动的理由。',
  },
  {
    id: 'perf',
    icon: 'codicon-dashboard',
    labelEn: 'Optimize Performance',
    labelZh: '性能优化',
    descEn: 'Find bottlenecks and speed it up',
    descZh: '分析瓶颈并给出优化',
    promptEn:
      'Analyze the selected code for performance bottlenecks (time/space complexity, I/O, rendering, allocations). Propose concrete optimizations, apply the safe ones, and explain the expected impact.',
    promptZh:
      '分析选中代码的性能瓶颈（时间/空间复杂度、IO、渲染、内存分配等），给出可落地的优化方案，实施其中安全的部分，并说明预期收益。',
  },
  {
    id: 'review',
    icon: 'codicon-eye',
    labelEn: 'Code Review',
    labelZh: '代码审查',
    descEn: 'Senior-level review by severity',
    descZh: '按严重程度列出问题',
    promptEn:
      'Review the selected code like a senior engineer: correctness, security, performance, error handling, and style. List findings ordered by severity, each with a concrete suggestion.',
    promptZh:
      '以资深工程师视角审查选中的代码：正确性、安全性、性能、异常处理与代码风格，按严重程度列出问题，并给出具体修改建议。',
  },
  {
    id: 'docs',
    icon: 'codicon-file-text',
    labelEn: 'Write Docs',
    labelZh: '编写文档',
    descEn: 'Doc comments with params and examples',
    descZh: '补全参数、返回值与示例',
    promptEn:
      'Add clear documentation comments to the selected code: purpose, parameters, return values, thrown errors, and a short usage example where helpful. Match the existing documentation style of the project.',
    promptZh:
      '为选中的代码补充清晰的文档注释：用途、参数、返回值、可能抛出的异常，必要时给出简短示例，并保持项目已有的注释风格。',
  },
  {
    id: 'comment',
    icon: 'codicon-comment',
    labelEn: 'Add Comments',
    labelZh: '添加注释',
    descEn: 'Explain the "why", not the "what"',
    descZh: '解释"为什么"而非"做什么"',
    promptEn:
      'Add concise inline comments to this complex logic, explaining *why* each step is done rather than *what* it does. Keep the code itself unchanged.',
    promptZh:
      '为这段逻辑复杂的代码添加简洁的逐段注释，解释每一步"为什么"这样做，而不是复述"做什么"，代码本身保持不变。',
  },
];

/** Pick the zh or en variant of a preset field based on the active UI language. */
export function pickQuickPromptText(
  preset: QuickPrompt,
  field: 'label' | 'desc' | 'prompt',
  language: string,
): string {
  const zh = language.toLowerCase().startsWith('zh');
  switch (field) {
    case 'label':
      return zh ? preset.labelZh : preset.labelEn;
    case 'desc':
      return zh ? preset.descZh : preset.descEn;
    case 'prompt':
      return zh ? preset.promptZh : preset.promptEn;
  }
}
