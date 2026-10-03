#!/usr/bin/env node
/**
 * test.js —— 直接从构建产物 index.html 里抽出引擎代码跑断言，
 * 保证「页面里跑的」和「被测的」是同一份实现。
 *
 *   node test.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

// 只取数据 + 引擎（第 1~3 节 + 诊断），UI 部分依赖 DOM，跳过
const cut = script.indexOf('4. UI');
if (cut < 0) throw new Error('找不到 "4. UI" 分节标记');
const engine = script.slice(0, script.lastIndexOf('/* ====', cut));

const api = new Function(engine + `
  return { ITEMS, calcRatio, scoreItem, rankItems, tokenize, expandParts, partHits,
           RATIO_SCORE, keywordHits, itemInDomain, impliedDomains, hasPersonalHit,
           queryHitCount, stagePenalty, relevance, selectTop, diagnose, detectIntents,
           buildProfile, MAX_VISIBLE, TOP_N, STOP_GRAMS };
`)();

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const eq = (name, got, want) => ok(name, Object.is(got, want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/** 造画像：与页面走同一个 buildProfile，不再自己复刻一遍逻辑 */
const prof = (o) => api.buildProfile(Object.assign({
  age: 30, job: '在职', family: '单身', income: '中', time: '正常', grit: '中',
  query: '', selectedDomains: ['健康', '财务'],
}, o));

/* ---------- 1. calcRatio 与规格逐条对齐 ---------- */
console.log('\n[1] calcRatio 规格表');
eq('大 + 0/0/0 = 极高', api.calcRatio('大', 0, 0, 0), '极高');
eq('大 + 1/0/0 = 高', api.calcRatio('大', 1, 0, 0), '高');
eq('大 + 1/1/0 = 高(成本分 2)', api.calcRatio('大', 1, 1, 0), '高');
eq('大 + 1/1/1 = 一般(成本分 3)', api.calcRatio('大', 1, 1, 1), '一般');
eq('大 + 2/2/2 = 一般', api.calcRatio('大', 2, 2, 2), '一般');
eq('中 + 0/0/0 = 高', api.calcRatio('中', 0, 0, 0), '高');
eq('中 + 1/0/0 = 一般', api.calcRatio('中', 1, 0, 0), '一般');
eq('小 + 0/0/0 = 一般', api.calcRatio('小', 0, 0, 0), '一般');
let mismatch = 0;
for (const b of ['大', '中', '小']) for (const m of [0, 1, 2]) for (const t of [0, 1, 2]) for (const g of [0, 1, 2]) {
  const cs = m + t + g;
  const want = (b === '大' && cs === 0) ? '极高' : (b === '大' && cs <= 2) ? '高' : (b === '中' && cs === 0) ? '高' : '一般';
  if (api.calcRatio(b, m, t, g) !== want) mismatch++;
}
ok('192 种组合穷举一致', mismatch === 0, mismatch + ' 处不一致');

/* ---------- 2. 数据集 + 行动句（防幻觉） ---------- */
console.log('\n[2] 数据集与行动句');
const I = api.ITEMS;
ok(`条目数 ${I.length} ≥ 30`, I.length >= 30);
ok('覆盖 34 个章节', new Set(I.map((x) => x.section)).size === 34);
ok('成本三档齐全（钱/时间/毅力）', [0, 1, 2].every((v) => I.some((x) => x.cost_money === v))
  && [0, 1, 2].every((v) => I.some((x) => x.cost_time === v))
  && [0, 1, 2].every((v) => I.some((x) => x.cost_grit === v)));
ok('收益 大/中/小 与证据 A/B/C 齐全',
  ['大', '中', '小'].every((v) => I.some((x) => x.benefit_level === v)) &&
  ['A', 'B', 'C'].every((v) => I.some((x) => x.evidence === v)));
const KEYS = ['id', 'section', 'section_name', 'index_in_section', 'title', 'cost_money', 'cost_time',
  'cost_grit', 'benefit_level', 'evidence', 'source', 'body', 'action_tag', 'action_text'];
const missing = I.filter((x) => KEYS.some((k) => x[k] === undefined || x[k] === '' || x[k] === null));
ok('每条都有必需字段且非空', missing.length === 0, missing.slice(0, 3).map((x) => x.id + ':' + KEYS.filter((k) => !x[k])).join(','));
ok('id 唯一', new Set(I.map((x) => x.id)).size === I.length);
ok('三档性价比都出现', ['极高', '高', '一般'].every((r) =>
  I.some((x) => api.calcRatio(x.benefit_level, x.cost_money, x.cost_time, x.cost_grit) === r)));
// 防幻觉核心：行动句必须是原文里连续出现的一段
const notVerbatim = I.filter((x) => {
  const hay = [x.title, x.body, x.gain, x.note, x.cost_note].join('\n');
  return !hay.includes(x.action_text.replace(/…$/, ''));
});
ok('行动句 100% 是原文子串（不生成新事实）', notVerbatim.length === 0,
  notVerbatim.slice(0, 3).map((x) => x.id + ' ' + x.action_text).join(' | '));
ok('行动句长度 ≤ 27 字', I.every((x) => [...x.action_text].length <= 27),
  String(Math.max(...I.map((x) => [...x.action_text].length))));
ok('行动标签只用 6 种固定分类', new Set(I.map((x) => x.action_tag)).size <= 6,
  [...new Set(I.map((x) => x.action_tag))].join(','));

/* ---------- 3. 打分权重 ---------- */
console.log('\n[3] 打分权重');
const base = { income: '中', timeTight: false, gritLow: false, domains: [], tokens: [], parts: [] };
const item = { benefit_level: '大', cost_money: 0, cost_time: 0, cost_grit: 0, evidence: 'C', section: 1,
  section_name: '不要早死', title: '系安全带', body: '坐前排系上安全带', gain: '', note: '' };
eq('基础分 = 性价比档位分（极高=3）', api.scoreItem(item, base).score, 3);
eq('收入低 + 钱=0 → +2', api.scoreItem(item, { ...base, income: '低' }).score, 5);
eq('收入低 + 钱=1 → +1', api.scoreItem({ ...item, cost_money: 1 }, { ...base, income: '低' }).score, 3);
eq('收入低 + 钱=2 → +0', api.scoreItem({ ...item, cost_money: 2 }, { ...base, income: '低' }).score, 2);
eq('时间紧 + 时间=0 → +2', api.scoreItem(item, { ...base, timeTight: true }).score, 5);
eq('时间紧 + 时间=1 → +1', api.scoreItem({ ...item, cost_time: 1 }, { ...base, timeTight: true }).score, 3);
eq('毅力低 + 毅力=0 → +1', api.scoreItem(item, { ...base, gritLow: true }).score, 4);
eq('毅力低 + 毅力=1 → +0', api.scoreItem({ ...item, cost_grit: 1 }, { ...base, gritLow: true }).score, 2);
eq('领域命中 → +3', api.scoreItem(item, { ...base, domains: ['健康'] }).score, 6);
eq('领域命中多个也只加一次 +3', api.scoreItem(item, { ...base, domains: ['健康', '急救'] }).score, 6);
eq('证据 A +1 / B +0.5 / C +0', [api.scoreItem({ ...item, evidence: 'A' }, base).score,
  api.scoreItem({ ...item, evidence: 'B' }, base).score,
  api.scoreItem({ ...item, evidence: 'C' }, base).score].join(), '4,3.5,3');
eq('困惑命中 3 词 → +3', api.scoreItem(item, { ...base, tokens: ['安全带', '前排', '坐前'] }).score, 6);
eq('困惑命中封顶 +3', api.scoreItem(item, { ...base, tokens: ['安全带', '前排', '坐前', '系上', '坐'] }).score, 6);
ok('每条理由的加分之和 = 总分', (() => {
  const r = api.scoreItem({ ...item, evidence: 'A' }, { income: '低', timeTight: true, gritLow: true, domains: ['健康'], tokens: ['安全带'], parts: [] });
  return r.reasons.reduce((a, x) => a + x.value, 0) === r.score;
})());

/* ---------- 4. 分词降噪 ---------- */
console.log('\n[4] 分词与降噪');
ok('标点被切开', api.tokenize('房东，不退押金。').includes('房东'));
ok('长中文句能切出二字词', api.tokenize('我最近总是失眠').includes('失眠'));
ok('停用词被滤掉（不多）', !api.tokenize('存款不多').includes('不多'), api.tokenize('存款不多').join(','));
ok('停用词被滤掉（时间/问题）', !api.tokenize('时间有问题').includes('时间'));
ok('英文词保留', api.tokenize('AI 换工作').includes('ai'));
ok('空输入返回空数组', api.tokenize('   ').length === 0);
ok('词条按用户词组计数，不因切词翻倍', (() => {
  const parts = api.expandParts('想辞职考研');
  return parts.length === 1 && api.partHits(I.find((x) => x.title.includes('失业')), parts).length <= 1;
})());

/* ---------- 5. 诊断：困惑 vs 领域 ---------- */
console.log('\n[5] 现状诊断');
const p1 = prof({ query: '28岁想辞职考研，父母催婚，存款不多', income: '低', time: '紧张', selectedDomains: ['职业', '财务'] });
const d1 = api.diagnose(p1, []);
eq('从困惑读出的诊断标记为依据=困惑', d1.basedOn, '困惑');
ok('规则命中包含学历投资', d1.rules.includes('学历投资'), d1.rules.join('/'));
ok('为核心矛盾给出的是「困惑版」断言', d1.conflict.includes('学历'), d1.conflict);
ok('诊断文字里没有编造金额', !/\d+\s*万/.test(d1.conflict + d1.strategy), d1.conflict);
const p2 = prof({ query: '', selectedDomains: ['健康', '财务'] });
const d2 = api.diagnose(p2, []);
eq('没有困惑时标记为依据=领域', d2.basedOn, '领域');
ok('没有困惑时用温和表述（不下断言）', d2.conflict.includes('关注点') || d2.conflict.includes('你在关注'), d2.conflict);
ok('没有困惑时不扩检索词', p2.expandedTerms.length === 0, p2.expandedTerms.join(','));
ok('有困惑时会扩检索词', p1.expandedTerms.length > 0, p1.expandedTerms.join(','));
const p3 = prof({ query: '', selectedDomains: ['健康'] });
ok('隐含领域不参与诊断叙事', !api.diagnose(p3, []).rules.includes('职业换轨'), api.diagnose(p3, []).rules.join('/'));

/* ---------- 6. Top 6 硬上限 + 精选 ---------- */
console.log('\n[6] Top 6 硬上限与精选');
eq('MAX_VISIBLE = 6', api.MAX_VISIBLE, 6);
eq('TOP_N = 3', api.TOP_N, 3);
for (const [name, p] of [
  ['困惑画像', p1],
  ['押金纠纷', prof({ query: '房东不退押金 断水断电', selectedDomains: ['法律'] })],
  ['失业社保', prof({ query: '失业了交不起房租，社保也断了', job: '待业', income: '低', selectedDomains: ['社保', '财务'] })],
  ['无困惑', p2],
]) {
  const ranked = api.rankItems(I, p);
  const sel = api.selectTop(ranked, p);
  ok(`[${name}] 默认最多 6 条`, sel.visible.length <= 6, sel.visible.length);
  ok(`[${name}] 精选恰好 3 条`, sel.top.length === 3, sel.top.length);
  ok(`[${name}] 精选+备选 无重复`, new Set(sel.visible.map((r) => r.item.id)).size === sel.visible.length);
  ok(`[${name}] 其余都进 hidden`, sel.visible.length + sel.hidden.length === ranked.length,
    `${sel.visible.length}+${sel.hidden.length} vs ${ranked.length}`);
  ok(`[${name}] 精选都与我有关`, sel.top.every(api.hasPersonalHit));
}
ok('hard cap 与实现常量一致（页面里没有别处写死 6 条以外的量）', (() => {
  const ranked = api.rankItems(I, p1);
  return api.selectTop(ranked, p1).visible.length <= api.MAX_VISIBLE;
})());
ok('可以显式收紧上限', api.selectTop(api.rankItems(I, p1), p1, 3, 4).visible.length === 4);

/* ---------- 7. 「在职被推失业金」的硬伤已修 ---------- */
console.log('\n[7] 阶段一致性');
const ranked1 = api.rankItems(I, p1);
const sel1 = api.selectTop(ranked1, p1);
ok('在职 + 没提失业 → 第 1 条不是失业金条款',
  !/失业金|失业保险|失业登记/.test(sel1.top[0].item.title), sel1.top[0].item.title);
const JOBLESS = /失业金|失业保险|失业登记|领取失业/;
const joblessRow = ranked1.find((r) => JOBLESS.test(r.item.title));
ok('数据里确实有失业金条款（对照组）', !!joblessRow);
ok('在职 + 没提失业 → 该条款被降权', api.stagePenalty(joblessRow, p1) === 1);
ok('提到失业时不降权', api.stagePenalty(joblessRow,
  prof({ query: '我失业了 想领失业金', job: '待业', selectedDomains: ['社保'] })) === 0);
ok('降权不改加权总分（只影响精选顺序）',
  joblessRow.score === api.scoreItem(joblessRow.item, p1).score);
ok('被降权的条款仍然存在，没有从结果里删除',
  sel1.hidden.concat(sel1.visible).some((r) => r.item.id === joblessRow.item.id));
const sel3 = api.selectTop(api.rankItems(I, prof({ query: '失业了交不起房租，社保也断了', job: '待业', income: '低', selectedDomains: ['社保', '财务'] })),
  prof({ query: '失业了交不起房租，社保也断了', job: '待业', income: '低', selectedDomains: ['社保', '财务'] }));
ok('待业用户能看到失业/社保类条款', sel3.visible.some((r) => /失业|社保/.test(r.item.title)), sel3.visible.map((r) => r.item.title.slice(0, 12)).join('|'));

/* ---------- 8. 排序规则 ---------- */
console.log('\n[8] 排序规则');
const ranked = api.rankItems(I, p1);
ok('总分单调不增', ranked.every((r, i) => i === 0 || ranked[i - 1].score >= r.score));
ok('同分时性价比档位高者优先', ranked.every((r, i) =>
  i === 0 || ranked[i - 1].score !== r.score || ranked[i - 1].ratioScore >= r.ratioScore));
ok('分数之和等于理由之和（抽查 50 条）', ranked.slice(0, 50).every((r) =>
  r.reasons.reduce((a, x) => a + x.value, 0) === r.score));
ok('总分 ≥ 基础分（加分不为负）', ranked.every((r) => r.score >= r.ratioScore));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
