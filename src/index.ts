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

type FeedFailure = {
  feedTitle: string;
  feedUrl: string;
  reason: string;
  errorType: 'timeout' | 'other';
};

type FeedFetchOutcome = {
  items: NewsItem[];
  failure: FeedFailure | null;
};

type FeedObservability = {
  sourceDir: string;
  opmlFileCount: number;
  totalFeedsInOpml: number;
  selectedFeedCount: number;
  failedFeedCount: number;
  failedRate: number;
  timeoutFeeds: string[];
  failedFeeds: FeedFailure[];
};

type ToolOutput = {
  profileKeywords: string[];
  selectedFeeds: Array<{ title: string; xmlUrl: string; score: number }>;
  items: NewsItem[];
  feedObservability: FeedObservability;
};

type CliOptions = {
  sourceDir: string;
  workBackground: string;
};

const REQUIRED_HEADINGS = [
  '## 本周发布了什么（最多 3-5 条简要概述）',
  '## 哪些内容与我的工作相关（1-2 条，附带背景）',
  '## 我应该在本周测试什么（具体操作）',
  '## 我可以完全忽略的内容（其他所有内容）',
] as const;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NEWS_DIR = path.join(PROJECT_ROOT, 'news');

function assertNonEmptyEnv(name: string, value: string | undefined): asserts value is string {
  if (typeof value === 'string' && value.trim() !== '') return;
  console.error(`Missing required env var: ${name}`);
  process.exit(1);
}

// Support both repo-specific name (OPENAI_KEY) and the more common (OPENAI_API_KEY).
const maybeKey = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
assertNonEmptyEnv('OPENAI_KEY (or OPENAI_API_KEY)', maybeKey);
const OPENAI_KEY = maybeKey;

const maybeModel = process.env.OPENAI_MODEL;
assertNonEmptyEnv('OPENAI_MODEL', maybeModel);
const OPENAI_MODEL = maybeModel;

// Default to OpenAI's public endpoint if not provided.
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

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

function parseCliArgs(argv: string[]): CliOptions {
  let sourceDir = process.env.SOURCE_DIR || 'rss-source';
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source-dir') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --source-dir');
      }
      sourceDir = next;
      i += 1;
      continue;
    }

    if (arg.startsWith('--source-dir=')) {
      sourceDir = arg.slice('--source-dir='.length);
      continue;
    }

    positional.push(arg);
  }

  const workBackground =
    positional.join(' ').trim() ||
    process.env.WORK_BACKGROUND ||
    '[AI工程师，Cursor/GitHub Copilot，开发与上线AI功能，软件/互联网]';

  return { sourceDir, workBackground };
}

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

function classifyFeedError(error: unknown): { errorType: 'timeout' | 'other'; reason: string } {
  const message = String((error as Error)?.message || error || 'unknown error');
  const lowered = message.toLowerCase();
  if (lowered.includes('timeout') || lowered.includes('timed out') || lowered.includes('etimedout')) {
    return { errorType: 'timeout', reason: message };
  }
  return { errorType: 'other', reason: message };
}

function hasRequiredHeadings(text: string): boolean {
  return REQUIRED_HEADINGS.every((heading) => text.includes(heading));
}

function extractSectionBody(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return '';

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('## ')) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

function extractListItems(sectionBody: string): string[] {
  const lines = sectionBody.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter((line) => line.length > 0);
}

function extractTrends(trendMarkdown: string): string[] {
  return trendMarkdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter((line) => line.length > 0);
}

function findToolOutput(result: { toolResults: Array<{ toolName: string; output: unknown }> }): ToolOutput | null {
  const matched = result.toolResults.find((t) => t.toolName === 'getLatestNewsFromRssSourceDir');
  if (!matched || !matched.output || typeof matched.output !== 'object') return null;
  return matched.output as ToolOutput;
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

async function loadFeedsFromSourceDir(
  sourceDir: string,
): Promise<{ opmlFiles: string[]; feeds: FeedInfo[]; totalFeedsInOpml: number }> {
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

  return {
    opmlFiles,
    feeds: [...dedup.values()],
    totalFeedsInOpml: merged.length,
  };
}

async function fetchFeedLatestItems(
  feed: FeedInfo,
  maxItemsPerFeed: number,
  sinceDate: Date,
): Promise<FeedFetchOutcome> {
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

    return {
      items: items.filter((item) => !item.publishedTimestamp || item.publishedTimestamp >= sinceDate.getTime()),
      failure: null,
    };
  } catch (error) {
    const classified = classifyFeedError(error);
    return {
      items: [
        {
          feedTitle: feed.title,
          feedUrl: feed.xmlUrl,
          title: '[feed unavailable]',
          link: '',
          publishedAt: '',
          publishedTimestamp: null,
          summary: `Failed to parse feed: ${classified.reason}`,
        },
      ],
      failure: {
        feedTitle: feed.title,
        feedUrl: feed.xmlUrl,
        reason: classified.reason,
        errorType: classified.errorType,
      },
    };
  }
}

async function collectNewsFromSourceDir(params: {
  sourceDir: string;
  workProfile: string;
  maxFeeds: number;
  maxItemsPerFeed: number;
  recentDays: number;
}): Promise<ToolOutput> {
  const { sourceDir, workProfile, maxFeeds, maxItemsPerFeed, recentDays } = params;
  const { opmlFiles, feeds, totalFeedsInOpml } = await loadFeedsFromSourceDir(sourceDir);
  const sinceDate = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000);

  const keywords = splitKeywords(workProfile);
  const rankedFeeds = feeds
    .map((feed) => ({
      ...feed,
      score: scoreByKeywords(`${feed.title} ${feed.xmlUrl}`, keywords),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFeeds);

  const outcomes = await Promise.all(
    rankedFeeds.map((feed) => fetchFeedLatestItems(feed, maxItemsPerFeed, sinceDate)),
  );

  const items = outcomes
    .flatMap((o) => o.items)
    .sort((a, b) => (b.publishedTimestamp || 0) - (a.publishedTimestamp || 0));

  const failedFeeds = outcomes
    .map((o) => o.failure)
    .filter((failure): failure is FeedFailure => Boolean(failure));

  const timeoutFeeds = failedFeeds
    .filter((f) => f.errorType === 'timeout')
    .map((f) => `${f.feedTitle} (${f.feedUrl})`);

  const observability: FeedObservability = {
    sourceDir,
    opmlFileCount: opmlFiles.length,
    totalFeedsInOpml,
    selectedFeedCount: rankedFeeds.length,
    failedFeedCount: failedFeeds.length,
    failedRate: rankedFeeds.length === 0 ? 0 : Number((failedFeeds.length / rankedFeeds.length).toFixed(4)),
    timeoutFeeds,
    failedFeeds,
  };

  return {
    profileKeywords: keywords,
    selectedFeeds: rankedFeeds.map(({ title, xmlUrl, score }) => ({ title, xmlUrl, score })),
    items,
    feedObservability: observability,
  };
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
  execute: async ({ sourceDir, workProfile, maxFeeds, maxItemsPerFeed, recentDays }) =>
    collectNewsFromSourceDir({ sourceDir, workProfile, maxFeeds, maxItemsPerFeed, recentDays }),
});

const cli = parseCliArgs(process.argv.slice(2));

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

function buildPrompt(workBackground: string, sourceDir: string, retry: boolean): string {
  const retryLine = retry
    ? '上一次输出缺少固定标题。请严格保证四个标题全部出现且逐字一致。'
    : '';

  return [
    `这是我的工作背景：${workBackground}。从以下 AI 新闻项目中，识别出对我的具体工作流有直接影响的发布内容。对于每个相关项目，简要说明它为什么对我的工作重要，以及我应当测试什么。忽略其他一切。`,
    `RSS 源目录：${sourceDir}。调用工具时必须使用这个 sourceDir。`,
    retryLine,
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
  ]
    .filter(Boolean)
    .join('\n');
}

async function generateValidatedReport(): Promise<{ text: string; toolOutput: ToolOutput | null; retries: number }> {
  let lastText = '';
  let lastToolOutput: ToolOutput | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = buildPrompt(cli.workBackground, cli.sourceDir, attempt > 0);
    const result = await rssAgent.generate({ prompt });
    const text = result.text.trim();
    const toolOutput = findToolOutput(result);

    lastText = text;
    lastToolOutput = toolOutput;

    if (hasRequiredHeadings(text)) {
      return { text, toolOutput, retries: attempt };
    }
  }

  return { text: lastText, toolOutput: lastToolOutput, retries: 1 };
}

const generated = await generateValidatedReport();
const previousReportPath = await getLatestReportFile();
const previousReport = previousReportPath ? await readFile(previousReportPath, 'utf8') : null;
const trendSummary = await summarizeTrend(previousReport, generated.text, cli.workBackground);

const now = new Date();
const timestamp = formatTimestamp(now);
const reportPath = path.join(NEWS_DIR, `${timestamp}.md`);
const jsonPath = path.join(NEWS_DIR, `${timestamp}.json`);

const fallbackToolOutput =
  generated.toolOutput ??
  (await collectNewsFromSourceDir({
    sourceDir: cli.sourceDir,
    workProfile: cli.workBackground,
    maxFeeds: 30,
    maxItemsPerFeed: 3,
    recentDays: 7,
  }));

const observability = fallbackToolOutput.feedObservability;
const failedRatePct = observability ? `${(observability.failedRate * 100).toFixed(2)}%` : 'N/A';
const timeoutLines =
  observability && observability.timeoutFeeds.length > 0
    ? observability.timeoutFeeds.map((x) => `- ${x}`)
    : ['- 无'];
const failedSampleLines =
  observability && observability.failedFeeds.length > 0
    ? observability.failedFeeds.slice(0, 10).map((f) => `- ${f.feedTitle}: ${f.reason}`)
    : ['- 无'];

const reportContent = [
  `# RSS News Report - ${timestamp}`,
  '',
  `- GeneratedAt: ${now.toISOString()}`,
  `- WorkBackground: ${cli.workBackground}`,
  `- SourceDir: ${cli.sourceDir}`,
  `- FormatValidationRetried: ${generated.retries > 0 ? 'yes' : 'no'}`,
  previousReportPath ? `- ComparedWith: ${path.basename(previousReportPath)}` : '- ComparedWith: none',
  '',
  generated.text,
  '',
  '## 与上次相比最值得关注的新趋势',
  trendSummary,
  '',
  '## Feed 拉取观测',
  `- OPML 文件数: ${observability?.opmlFileCount ?? 'N/A'}`,
  `- OPML 内源总数（去重前）: ${observability?.totalFeedsInOpml ?? 'N/A'}`,
  `- 本次选取源数: ${observability?.selectedFeedCount ?? 'N/A'}`,
  `- 失败源数: ${observability?.failedFeedCount ?? 'N/A'}`,
  `- 失败率: ${failedRatePct}`,
  '- 超时源列表:',
  ...timeoutLines,
  '- 失败样本:',
  ...failedSampleLines,
  '',
].join('\n');

await mkdir(NEWS_DIR, { recursive: true });
await writeFile(reportPath, reportContent, 'utf8');

const section1 = extractSectionBody(generated.text, REQUIRED_HEADINGS[0]);
const section2 = extractSectionBody(generated.text, REQUIRED_HEADINGS[1]);
const section3 = extractSectionBody(generated.text, REQUIRED_HEADINGS[2]);
const section4 = extractSectionBody(generated.text, REQUIRED_HEADINGS[3]);

const structured = {
  timestamp,
  generatedAt: now.toISOString(),
  workBackground: cli.workBackground,
  sourceDir: cli.sourceDir,
  comparedWith: previousReportPath ? path.basename(previousReportPath) : null,
  reportMarkdownPath: reportPath,
  reportJsonPath: jsonPath,
  formatValidationRetried: generated.retries > 0,
  sections: {
    releases: extractListItems(section1),
    relevant: extractListItems(section2),
    tests: extractListItems(section3),
    ignored: extractListItems(section4),
  },
  trends: extractTrends(trendSummary),
  feedObservability: observability ?? null,
};

await writeFile(jsonPath, JSON.stringify(structured, null, 2), 'utf8');

console.log(reportContent);
console.log(`Saved Markdown: ${reportPath}`);
console.log(`Saved JSON: ${jsonPath}`);
