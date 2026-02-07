import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import { Experimental_Agent as Agent, stepCountIs, tool } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { XMLParser } from 'fast-xml-parser';
import Parser from 'rss-parser';
import { z } from 'zod';

type FeedInfo = {
  title: string;
  xmlUrl: string;
  htmlUrl: string;
};

type NewsItem = {
  feedTitle: string;
  feedUrl: string;
  title: string;
  link: string;
  publishedAt: string;
  publishedTimestamp: number | null;
  summary: string;
};

type ParserItemExt = {
  'content:encoded'?: string;
  description?: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NEWS_DIR = path.join(PROJECT_ROOT, 'news');

const OPENAI_KEY = process.env.OPENAI_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;

if (!OPENAI_KEY || !OPENAI_MODEL || !OPENAI_BASE_URL) {
  console.error('Missing required env vars: OPENAI_KEY, OPENAI_MODEL, OPENAI_BASE_URL');
  process.exit(1);
}

const MODEL_ID = OPENAI_MODEL;

const openai = createOpenAICompatible({
  name: 'openai-compatible',
  apiKey: OPENAI_KEY,
  baseURL: OPENAI_BASE_URL,
});

const rssParser = new Parser<Record<string, unknown>, ParserItemExt>({
  timeout: 10_000,
  customFields: {
    item: ['content:encoded', 'description'],
  },
});

function splitKeywords(workProfile: string): string[] {
  return [
    ...new Set(
      workProfile
        .toLowerCase()
        .split(/[\s,，。；;、|/\\]+/)
        .map((k) => k.trim())
        .filter((k) => k.length >= 2),
    ),
  ];
}

function scoreByKeywords(text: string, keywords: string[]): number {
  const source = text.toLowerCase();
  return keywords.reduce((score, keyword) => (source.includes(keyword) ? score + 1 : score), 0);
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatTimestamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

async function getLatestReportFile(): Promise<string | null> {
  await mkdir(NEWS_DIR, { recursive: true });
  const files = await readdir(NEWS_DIR);
  const markdownFiles = files.filter((f) => f.endsWith('.md')).sort();
  if (markdownFiles.length === 0) return null;
  return path.join(NEWS_DIR, markdownFiles[markdownFiles.length - 1]);
}

async function summarizeTrend(
  previousReport: string | null,
  currentReport: string,
  workBackground: string,
): Promise<string> {
  if (!previousReport) {
    return '- 首次运行，暂无上次结果可对比。建议明天再次运行以观察趋势变化。';
  }

  const trendAgent = new Agent({
    model: openai(MODEL_ID),
    stopWhen: stepCountIs(1),
    instructions: [
      '你是新闻趋势分析助手。',
      '对比“上次报告”和“本次报告”，只提炼最值得关注的新趋势。',
      '输出必须是中文 Markdown 列表，1-3 条，每条一行。',
      '每条需包含：新趋势 + 为什么重要（面向工作流）。',
      '不要输出标题、不要输出额外解释。',
    ].join(' '),
  });

  const trendPrompt = [
    `工作背景：${workBackground}`,
    '请对比以下两次报告，找出最值得关注的新趋势：',
    '--- 上次报告 ---',
    previousReport.slice(0, 7000),
    '--- 本次报告 ---',
    currentReport.slice(0, 7000),
  ].join('\n');

  const trend = await trendAgent.generate({ prompt: trendPrompt });
  const content = trend.text.trim();
  if (!content) {
    return '- 本次与上次相比未识别到明确的新趋势。';
  }
  return content;
}

async function loadFeedsFromSingleOpml(fullPath: string): Promise<FeedInfo[]> {
  const file = await readFile(fullPath, 'utf8');

  const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
  });

  const parsed = xmlParser.parse(file) as {
    opml?: {
      body?: {
        outline?: unknown;
      };
    };
  };

  const bodyOutlines = parsed?.opml?.body?.outline;
  if (!bodyOutlines) return [];

  const stack: unknown[] = Array.isArray(bodyOutlines) ? [...bodyOutlines] : [bodyOutlines];
  const feeds: FeedInfo[] = [];

  while (stack.length > 0) {
    const current = stack.pop() as
      | {
          title?: string;
          text?: string;
          xmlUrl?: string;
          htmlUrl?: string;
          outline?: unknown;
        }
      | undefined;

    if (!current) continue;

    if (current.xmlUrl) {
      feeds.push({
        title: current.title || current.text || current.xmlUrl,
        xmlUrl: current.xmlUrl,
        htmlUrl: current.htmlUrl || '',
      });
    }

    if (current.outline) {
      if (Array.isArray(current.outline)) {
        for (const child of current.outline) stack.push(child);
      } else {
        stack.push(current.outline);
      }
    }
  }

  return feeds;
}

async function loadFeedsFromSourceDir(sourceDir: string): Promise<FeedInfo[]> {
  const fullDir = path.isAbsolute(sourceDir) ? sourceDir : path.join(PROJECT_ROOT, sourceDir);
  await mkdir(fullDir, { recursive: true });

  const entries = await readdir(fullDir, { withFileTypes: true });
  const opmlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.opml'))
    .map((entry) => path.join(fullDir, entry.name))
    .sort();

  if (opmlFiles.length === 0) {
    throw new Error(`No .opml files found in source directory: ${fullDir}`);
  }

  const settled = await Promise.all(opmlFiles.map((filePath) => loadFeedsFromSingleOpml(filePath)));
  const merged = settled.flat();
  const dedup = new Map<string, FeedInfo>();
  for (const feed of merged) {
    if (!dedup.has(feed.xmlUrl)) dedup.set(feed.xmlUrl, feed);
  }
  return [...dedup.values()];
}

async function fetchFeedLatestItems(
  feed: FeedInfo,
  maxItemsPerFeed: number,
  sinceDate: Date,
): Promise<NewsItem[]> {
  try {
    const feedContent = await rssParser.parseURL(feed.xmlUrl);
    const items: NewsItem[] = (feedContent.items || []).slice(0, maxItemsPerFeed).map((item) => {
      const publishedAt = item.isoDate || item.pubDate || '';
      const dateObj = parseDate(publishedAt);
      const summary = item['content:encoded'] || item.contentSnippet || item.description || '';

      return {
        feedTitle: feed.title,
        feedUrl: feed.xmlUrl,
        title: item.title || '(untitled)',
        link: item.link || '',
        publishedAt,
        publishedTimestamp: dateObj ? dateObj.getTime() : null,
        summary: summary.slice(0, 700),
      };
    });

    return items.filter((item) => !item.publishedTimestamp || item.publishedTimestamp >= sinceDate.getTime());
  } catch (error) {
    return [
      {
        feedTitle: feed.title,
        feedUrl: feed.xmlUrl,
        title: '[feed unavailable]',
        link: '',
        publishedAt: '',
        publishedTimestamp: null,
        summary: `Failed to parse feed: ${String((error as Error)?.message || error)}`,
      },
    ];
  }
}

const getLatestNewsFromRssSourceDir = tool({
  description:
    'Read all .opml files from the rss source directory, merge feed urls, and return recent news entries.',
  inputSchema: z.object({
    sourceDir: z.string().default('rss-source'),
    workProfile: z.string().describe('The user work profile'),
    maxFeeds: z.number().int().min(1).max(80).default(30),
    maxItemsPerFeed: z.number().int().min(1).max(10).default(3),
    recentDays: z.number().int().min(1).max(30).default(7),
  }),
  execute: async ({ sourceDir, workProfile, maxFeeds, maxItemsPerFeed, recentDays }) => {
    const feeds = await loadFeedsFromSourceDir(sourceDir);
    const sinceDate = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000);

    const keywords = splitKeywords(workProfile);
    const rankedFeeds = feeds
      .map((feed) => ({
        ...feed,
        score: scoreByKeywords(`${feed.title} ${feed.xmlUrl}`, keywords),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxFeeds);

    const settled = await Promise.all(
      rankedFeeds.map((feed) => fetchFeedLatestItems(feed, maxItemsPerFeed, sinceDate)),
    );

    const items = settled.flat().sort((a, b) => (b.publishedTimestamp || 0) - (a.publishedTimestamp || 0));

    return {
      profileKeywords: keywords,
      selectedFeeds: rankedFeeds.map(({ title, xmlUrl, score }) => ({ title, xmlUrl, score })),
      items,
    };
  },
});

const workBackground =
  process.argv.slice(2).join(' ').trim() ||
  process.env.WORK_BACKGROUND ||
  '[AI工程师，Cursor/GitHub Copilot，开发与上线AI功能，软件/互联网]';

const rssAgent = new Agent({
  model: openai(MODEL_ID),
  tools: {
    getLatestNewsFromRssSourceDir,
  },
  stopWhen: stepCountIs(4),
  instructions: [
    'You are RSSAgent for AI news triage.',
    'Always call getLatestNewsFromRssSourceDir first.',
    'You must output in Chinese with exactly 4 sections and keep concise.',
    'The 4 section titles must match the required text exactly, character by character.',
    'Section 1 title: 本周发布了什么（最多 3-5 条简要概述）',
    'Section 2 title: 哪些内容与我的工作相关（1-2 条，附带背景）',
    'Section 3 title: 我应该在本周测试什么（具体操作）',
    'Section 4 title: 我可以完全忽略的内容（其他所有内容）',
    'Prioritize direct workflow impact and include links for relevant/test items.',
  ].join(' '),
});

const prompt = [
  `这是我的工作背景：${workBackground}。从以下 AI 新闻项目中，识别出对我的具体工作流有直接影响的发布内容。对于每个相关项目，简要说明它为什么对我的工作重要，以及我应当测试什么。忽略其他一切。`,
  '输出要求：将筛选后的输出内容结构化并总结为以下4段，且必须使用完全一致的标题：',
  '1. 本周发布了什么（最多 3-5 条简要概述）',
  '2. 哪些内容与我的工作相关（1-2 条，附带背景）',
  '3. 我应该在本周测试什么（具体操作）',
  '4. 我可以完全忽略的内容（其他所有内容）',
  '标题必须逐字一致，不允许省略括号内容，不允许改写标题。',
  '如果某部分没有内容，写“无”。',
  '除这四段外不要输出其它段落。',
  '必须严格按以下 Markdown 模板输出：',
  '## 本周发布了什么（最多 3-5 条简要概述）',
  '- ...',
  '## 哪些内容与我的工作相关（1-2 条，附带背景）',
  '- ...',
  '## 我应该在本周测试什么（具体操作）',
  '1. ...',
  '## 我可以完全忽略的内容（其他所有内容）',
  '- ...',
].join('\n');

const result = await rssAgent.generate({
  prompt,
});

const previousReportPath = await getLatestReportFile();
const previousReport = previousReportPath ? await readFile(previousReportPath, 'utf8') : null;
const trendSummary = await summarizeTrend(previousReport, result.text, workBackground);

const now = new Date();
const timestamp = formatTimestamp(now);
const reportPath = path.join(NEWS_DIR, `${timestamp}.md`);
const reportContent = [
  `# RSS News Report - ${timestamp}`,
  '',
  `- GeneratedAt: ${now.toISOString()}`,
  `- WorkBackground: ${workBackground}`,
  previousReportPath ? `- ComparedWith: ${path.basename(previousReportPath)}` : '- ComparedWith: none',
  '',
  result.text.trim(),
  '',
  '## 与上次相比最值得关注的新趋势',
  trendSummary,
  '',
].join('\n');

await writeFile(reportPath, reportContent, 'utf8');

console.log(reportContent);
console.log(`Saved: ${reportPath}`);
