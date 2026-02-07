# RSS News Agent（中文）

[English](./README.md)

一个基于 Vercel AI SDK 的 TypeScript RSS 新闻 Agent。  
它会自动读取 `rss-source/` 目录下所有 `.opml` 文件中的 RSS 源，抓取最新内容，并筛选出与你工作流直接相关的新闻。

## RSS 来源说明

当前 OPML RSS 源列表基于以下推荐整理：

- Karpathy 在 X 的帖子：[https://x.com/karpathy/status/2018043254986703167](https://x.com/karpathy/status/2018043254986703167)
- 推荐 RSS 清单（gist）：[https://gist.github.com/emschwartz/e6d2bf860ccc367fe37ff953ba6de66b](https://gist.github.com/emschwartz/e6d2bf860ccc367fe37ff953ba6de66b)

## 功能特性

- 读取并解析 OPML RSS 源列表
- 抓取最新 RSS 条目，带超时与失败隔离
- 使用 AI Agent + Tool Call 做工作相关性筛选
- 输出固定 4 段结构，便于每周行动
- 每次运行自动保存到 `news/<时间戳>.md`
- 自动与上次结果对比，并附加“最值得关注的新趋势”

## 环境要求

- Node.js 20+
- npm 10+
- OpenAI 协议兼容接口

## 安装

1. 安装依赖：

```bash
npm install
```

2. 配置环境变量：

```bash
cp .env.example .env
```

必填变量：

- `OPENAI_KEY`
- `OPENAI_MODEL`
- `OPENAI_BASE_URL`

## 使用方式

显式传入工作背景：

```bash
npm start -- "AI工程师, Cursor, 开发AI功能, 互联网"
```

只要把 `.opml` 文件放进 `rss-source/` 目录，程序下次运行就会自动解析。

或在环境变量中设置默认背景：

```bash
WORK_BACKGROUND="[你的角色, 你的工具, 你的日常任务, 你的行业]"
npm start
```

## RSS 源目录规则

- 程序会扫描 `rss-source/` 下全部 `.opml` 文件
- 多个 OPML 中的 RSS 源会自动合并
- 相同 `xmlUrl` 的源会自动去重
- 当 `rss-source/` 中没有任何 `.opml` 文件时，程序会报错提示

## 运行结果存档与自动对比

- 每次运行都会生成一份报告：`news/<YYYYMMDD-HHmmss>.md`
- 报告中会记录本次时间、工作背景、以及对比的上一份报告文件名
- 首次运行：显示“暂无上次结果可对比”
- 第二次及以后：自动对比上次报告，并输出“与上次相比最值得关注的新趋势”

## 输出结构

程序会严格输出以下 4 个部分：

1. `本周发布了什么（最多 3-5 条简要概述）`
2. `哪些内容与我的工作相关（1-2 条，附带背景）`
3. `我应该在本周测试什么（具体操作）`
4. `我可以完全忽略的内容（其他所有内容）`

## 可用脚本

- `npm start`：执行一次 Agent
- `npm run dev`：监听模式运行
- `npm run typecheck`：TypeScript 类型检查

## 项目结构

```text
src/index.ts                 # 主程序（Agent + 工具实现）
rss-source/*.opml            # RSS 源文件（自动加载）
news/                        # 每次运行生成的 Markdown 报告
requirement.md               # 需求说明
```

## 安全建议

- 不要提交 `.env`
- 开发环境尽量使用低权限 API Key
- 打开未知链接前先确认来源

## 许可证

MIT，详见 `LICENSE`。
