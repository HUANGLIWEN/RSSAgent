# RSS News Agent

[中文文档](./README.zh-CN.md)

A TypeScript RSS news agent built with Vercel AI SDK.  
It reads RSS feed URLs from all `.opml` files under `rss-source/`, fetches latest items, and outputs only the content directly relevant to your work background.

## RSS Source Attribution

The OPML feed list is based on recommendations from:

- Karpathy's X post: [https://x.com/karpathy/status/2018043254986703167](https://x.com/karpathy/status/2018043254986703167)
- Recommended RSS gist: [https://gist.github.com/emschwartz/e6d2bf860ccc367fe37ff953ba6de66b](https://gist.github.com/emschwartz/e6d2bf860ccc367fe37ff953ba6de66b)

## Features

- Read and parse OPML feed list
- Fetch latest RSS entries with timeout and failure isolation
- Use AI Agent + tool calls to filter by workflow relevance
- Output in fixed 4-section structure for weekly action
- Save every run to `news/<timestamp>.md`
- Auto-compare with the previous report and append "most important new trends"

## Requirements

- Node.js 20+
- npm 10+
- OpenAI-compatible API endpoint

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment variables:

```bash
cp .env.example .env
```

Required variables:

- `OPENAI_KEY`
- `OPENAI_MODEL`
- `OPENAI_BASE_URL`

## Usage

Run with explicit work background:

```bash
npm start -- "AI工程师, Cursor, 开发AI功能, 互联网"
```

Any `.opml` file placed under `rss-source/` will be automatically parsed on the next run.

Or set default in env:

```bash
WORK_BACKGROUND="[你的角色, 你的工具, 你的日常任务, 你的行业]"
npm start
```

## RSS Source Directory Rules

- The agent scans all `.opml` files under `rss-source/`
- Feed URLs from multiple OPML files are merged
- Duplicate feeds are removed by `xmlUrl`
- If no `.opml` files exist in `rss-source/`, the run exits with an explicit error

## Report Persistence and Auto-Comparison

- Each run creates a report file: `news/<YYYYMMDD-HHmmss>.md`
- The report includes generated time, work background, and compared previous report file name
- First run: shows that no previous report is available
- Subsequent runs: auto-compare with the latest previous report and append "most important new trends"

## Output Format

The agent outputs exactly these 4 sections:

1. `本周发布了什么（最多 3-5 条简要概述）`
2. `哪些内容与我的工作相关（1-2 条，附带背景）`
3. `我应该在本周测试什么（具体操作）`
4. `我可以完全忽略的内容（其他所有内容）`

## Scripts

- `npm start`: run the agent once
- `npm run dev`: run with watch mode
- `npm run typecheck`: TypeScript type check

## Project Structure

```text
src/index.ts                 # Main agent implementation
rss-source/*.opml            # RSS source files (auto-loaded)
news/                        # Generated markdown reports per run
requirement.md               # Original requirement notes
```

## Security Notes

- Do not commit `.env`
- Use low-privilege API keys in development
- Validate links before opening unknown content

## License

MIT. See `LICENSE`.
