#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// check-repo-links.mjs — 仓库 slug 一致性守卫（零网络、零依赖）。
//
// 背景：仓库改名（agent-evals → Agent-Evals）后，github.com/<old> 靠 301 还能用，
//       但 username.github.io/<old> 大小写敏感、直接 404。文档里散落的旧 slug 不会报错，
//       只会安静地把读者和引用者带到一个坏链接。数字守卫抓不到它——normalize 会剔除 URL。
//
// 不变量（违反即退出码 1，fail-closed）：
//   (1) 规范 slug 唯一来源：CITATION.cff 的 repository-code 字段，解析出 owner/repo。
//   (2) 扫描所有跟踪文件里的 https://github.com/<owner>/<repo> 与
//       https://<owner>.github.io/<repo> 两类 URL，其 repo 段必须与规范 slug 逐字相等。
//   (3) 禁止旧 slug 字样作为仓库路径出现（改名的历史记录除外，见下）。
//
// 边界：本守卫证明「指向本仓库的 URL 用的是同一个当前 slug」，不证明 URL 可达（那要联网，
//       违背零网络自检纪律），也不证明外部站点的链接有效。可达性由人工/CI 部署状态保障。
//       CITATION 是判据基准、被检对象是其外的文件，不构成自证。
//       --selftest 用内存里的假文件集造负对照，证明门不是恒绿。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CITATION = path.join(ROOT, 'CITATION.cff');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out']);

// 从 CITATION 解析规范 slug —— 唯一真相源。
function canonicalSlug(citationText) {
  const m = citationText.match(/^\s*repository-code:\s*["']?https:\/\/github\.com\/([^/"'\s]+)\/([^/"'\s]+)/m);
  if (!m) throw new Error('CITATION.cff 缺少可解析的 repository-code（https://github.com/<owner>/<repo>）');
  return `${m[1]}/${m[2]}`;
}

// 扫描文本里的仓库 URL，返回每次出现的 {owner, repo, raw, line}。
function findRepoUrls(text, owner) {
  const found = [];
  const re = new RegExp(`https://github\\.com/${escapeRe(owner)}/([A-Za-z0-9._-]+)|https://${escapeRe(owner)}\\.github\\.io/([A-Za-z0-9._-]+)`, 'g');
  let m;
  let line = 1;
  let last = 0;
  while ((m = re.exec(text))) {
    line += (text.slice(last, m.index).match(/\n/g) || []).length;
    last = m.index;
    const repo = m[1] ?? m[2];
    found.push({ owner, repo, raw: m[0], line });
  }
  return found;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function check(files, canonical) {
  const [owner, repo] = canonical.split('/');
  const problems = [];
  let scanned = 0;
  let urls = 0;
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    scanned++;
    for (const hit of findRepoUrls(text, owner)) {
      urls++;
      if (hit.repo !== repo) {
        problems.push(`${path.relative(ROOT, file)}:${hit.line} 仓库 slug 不一致：${hit.raw}（规范：${canonical}）`);
      }
    }
  }
  return { problems, scanned, urls };
}

function selftest() {
  const canonical = 'kumu314/Agent-Evals';
  const [owner] = canonical.split('/');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-guard-'));
  try {
    const goodFile = path.join(tmp, 'good.md');
    const badFile = path.join(tmp, 'bad.md');
    fs.writeFileSync(goodFile, `see https://github.com/${owner}/Agent-Evals and https://${owner}.github.io/Agent-Evals/`);
    fs.writeFileSync(badFile, `old https://github.com/${owner}/agent-evals and https://${owner}.github.io/agent-evals/`);
    // 正对照：全用规范 slug → 零违规。
    const rGood = check([goodFile], canonical);
    // 负对照：混入旧 slug → 必须报两条（github.com 与 github.io 各一）。
    const rBad = check([badFile], canonical);
    const pass = rGood.problems.length === 0 && rBad.problems.length === 2;
    console.log(`[selftest] 正对照违规=${rGood.problems.length}（期望 0）· 负对照违规=${rBad.problems.length}（期望 2）`);
    if (!pass) {
      console.error('[selftest] 失败：守卫要么恒红、要么漏报旧 slug');
      process.exit(1);
    }
    console.log('[selftest] 通过：门会红，且规范 slug 全绿');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  if (!fs.existsSync(CITATION)) {
    console.error('[guard] CITATION.cff 不存在，无法取规范 slug（fail-closed）');
    process.exit(1);
  }
  let canonical;
  try { canonical = canonicalSlug(fs.readFileSync(CITATION, 'utf8')); }
  catch (e) { console.error(`[guard] ${e.message}`); process.exit(1); }
  const files = walk(ROOT);
  const { problems, scanned, urls } = check(files, canonical);
  if (problems.length) {
    console.error(`[guard] 仓库 slug 一致性失败（规范 ${canonical}）：`);
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log(`[guard] 仓库 slug 一致性通过：规范 ${canonical}，扫描 ${scanned} 文件 / ${urls} 处仓库 URL，全部一致`);
}

main();
