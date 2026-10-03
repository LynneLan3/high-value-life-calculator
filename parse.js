#!/usr/bin/env node
/**
 * parse.js —— 把《高性价比人生指南》(HowToLiveBetter) 的 book/*.md 解析成结构化 JSON。
 *
 * 用法（零依赖，Node 18+ 即可）：
 *   node parse.js                       # 默认读 src/book/*.md，写 data.json，并注入 src/template.html -> index.html
 *   node parse.js --book=./book         # 指定 markdown 目录
 *   node parse.js --out=./data.json     # 指定 JSON 输出路径
 *   node parse.js --no-build            # 只产出 JSON，不生成 index.html
 *
 * 抓取原始 markdown（用于替换真实数据）：
 *   git clone --depth 1 https://github.com/eternity4719/HowToLiveBetter tmp
 *   mkdir -p src/book && cp tmp/book/*.md src/book/
 *   node parse.js
 *
 * 每节 markdown 的格式约定（原仓库即如此）：
 *   # 15. 租房与买房                       <- 一级标题 = 章节
 *   ### 1. 押金必须写进合同                 <- 三级标题 = 建议标题
 *   <!-- 成本标签: 钱=0 时间=少 毅力=些 收益=中 口径=金钱 -->
 *   - 成本：不花钱。签合同时多花十分钟。
 *   - 说人话：押金多少、什么时候退……      <- 正文（说人话）
 *   - 收益：行政法规写得很明白……          <- 论证 / 依据
 *   - 证据等级：A
 *   - 来源：国务院 (2025). 住房租赁条例……
 *   - 备注：退租那天和房东一起拍照录像……
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * 1. 三档成本映射：原书用中文档位表述，这里统一换成 0/1/2 数值分。
 * ------------------------------------------------------------------ */
const COST_W = {
  money: { '0': 0, '少': 1, '多': 2 },
  time: { '少': 0, '中': 1, '多': 2 },
  will: { '否': 0, '些': 1, '是': 2 },
};

/** 把「0/少/多」之类的档位文本转成 0/1/2；无法识别时按 0 处理。 */
function costTier(text, kind) {
  const key = String(text ?? '').trim();
  if (key === '' ) return 0;
  if (/^[012]$/.test(key)) return Number(key);          // 已经写死数字的
  const v = COST_W[kind][key];
  return v === undefined ? 0 : v;
}

/* ------------------------------------------------------------------ *
 * 2. 单文件解析
 * ------------------------------------------------------------------ */

/** 去掉 markdown 行内标记，保留可读文本。 */
function clean(s) {
  return String(s ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\\([*_\[\]])/g, '$1')
    .replace(/<((?:https?:)\/\/[^>]+)>/g, '$1')          // <https://x> -> https://x
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析一个 markdown 文件，返回 { section, section_name, entries } */
function parseChapter(text, fallbackSection) {
  const lines = text.split(/\r?\n/);

  let section = fallbackSection;
  let sectionName = '';
  let sawH1 = false;

  const entries = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    if (!cur.title) { cur = null; return; }
    entries.push(cur);
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    // 一级标题：# 15. 租房与买房
    const h1 = /^#\s+(\d+)[.、]\s*(.+?)\s*$/.exec(line);
    if (h1) {
      section = Number(h1[1]);
      sectionName = clean(h1[2]);
      sawH1 = true;
      continue;
    }

    // 三级标题：### 1. 押金必须写进合同
    const h3 = /^###\s+(\d+)[.、]\s*(.+?)\s*$/.exec(line);
    if (h3) {
      flush();
      cur = {
        order: Number(h3[1]),
        title: clean(h3[2]),
        money: '0', time: '少', will: '否', level: '中', lens: '',
        cost: '', human: '', gain: '', grade: '', src: '', note: '',
      };
      continue;
    }

    // 成本标签注释：<!-- 成本标签: 钱=0 时间=少 毅力=些 收益=中 口径=金钱 -->
    const tag = /^<!--\s*成本标签:\s*(.*?)\s*-->$/.exec(line);
    if (tag && cur) {
      for (const kv of tag[1].split(/\s+/)) {
        const [k, v] = kv.split('=');
        if (k === '钱') cur.money = v;
        else if (k === '时间') cur.time = v;
        else if (k === '毅力') cur.will = v;
        else if (k === '收益') cur.level = v;
        else if (k === '口径') cur.lens = v;
      }
      continue;
    }

    if (!cur) continue;

    const field = /^-\s*(成本|说人话|收益|证据等级|来源|备注)[:：]\s*(.*)$/.exec(line);
    if (field) {
      const [, key, val] = field;
      if (key === '成本') cur.cost = clean(val);
      else if (key === '说人话') cur.human = clean(val);
      else if (key === '收益') cur.gain = clean(val);
      else if (key === '证据等级') cur.grade = (clean(val).match(/^[ABC]/) || [''])[0];
      else if (key === '来源') cur.src = clean(val);
      else if (key === '备注') cur.note = clean(val);
      continue;
    }

    // 折行续写：接在上一段字段后面
    if (line && !line.startsWith('#') && !line.startsWith('|') && !line.startsWith('>')) {
      if (cur.note) cur.note += ' ' + clean(line);
      else if (cur.src) cur.src += ' ' + clean(line);
      else if (cur.gain) cur.gain += ' ' + clean(line);
    }
  }
  flush();

  if (!sawH1) sectionName = sectionName || `第 ${section} 节`;
  return { section, section_name: sectionName, entries };
}

/* ------------------------------------------------------------------ *
 * 3.5 行动标签：从原文里逐字挑一句可执行的，不改写、不生成。
 *     action_text 一定是 title/body/gain/note 里连续出现的一段文字，
 *     这样卡片上的「行动建议」永远能在原书里核对到（防幻觉）。
 * ------------------------------------------------------------------ */

/** 由章节名 + 正文线索给这句话分类。 */
function actionTag(sectionName, text) {
  const s = String(sectionName || '');
  const t = String(text || '');
  if (/紧急|急救|报警|窒息|出血|中毒|火灾|AED/.test(s + t)) return '应急动作';
  if (/不要|别[把再买用做贪图]|禁止|不得|违法|红线|骗|陷阱|警惕|小心|远离|千万别/.test(t)) return '防坑红线';
  if (/法律|红线|搭进去|合规|账号|信息安全|常备药/.test(s)) return '防坑红线';
  if (/钱|租房|买房|创业|生意|在职|离职|工伤|工伤|技能/.test(s)) return '省钱兜底';
  if (/早死|慢慢死|慢性病|看病|外形|精力|残疾|放松|打击/.test(s)) return '健康行动';
  if (/老人|孩子|怀孕|生产|恋爱|结婚|上学|走了以后|出国/.test(s)) return '办事清单';
  return '行动建议';
}

// 能当「动作」开头的词。候选句子必须以此开头，否则不采纳 —— 这条约束挡掉了
// 「不是随机分组的试验」「用不了 20 分钟」这类半截话（代价是约 14% 的条款退回标题从句）。
const ACTION_START = ['先', '别', '不要', '不', '要', '应', '请', '把', '立刻', '马上', '立即', '定期', '每天', '每年',
  '记得', '务必', '尽量', '至少', '最好', '建议', '可以', '需要', '用', '打', '走', '找', '查', '办', '签', '核对',
  '保存', '留', '停', '关', '换', '算', '问', '带', '买', '存', '报', '拒绝', '避免', '控制', '坚持', '学会', '确认',
  '检查', '记录', '通知', '申请', '拨打', '及时', '当场', '拿', '让', '只', '远离', '警惕', '千万', '绝不', '改', '选',
  '装', '备', '预约', '去', '给', '向', '按', '认', '看', '听', '读', '写', '吃', '喝', '睡', '戒', '补'];
// 半截话的尾巴：出现这些结尾说明从句被切断了
const BAD_TAIL = /(的|了|一样|概率|问题|时候|情况|原因|以上|以下|左右|地方|东西|人们|人数|比例|平均|意味|意思|选项|说法|认定|试验|基础|结果|过程|阶段|水平|状态)$/;
// 法条原文 / 统计口径，不是可执行动作
const LEGAL_TEXT = /本法|依照本|违反本|第[一二三四五六七八九十百千]+条|行政处罚法|民法典|刑法|万人|百分之/;
// 单字动词开头容易被误判（「用不了 20 分钟」「查出来最多的是虚惊一场」「不发装备的那一类干预」）
const BAD_OPENING = /^(用|查|看|听|读|写|算|问|带|买|存|报|拿|让|只|去|给|向|按|认|吃|喝|睡|补|装|备|改|选|打|走|找|办|签)(了|出|到|完|不|得)|^(不|没)(发|申领|设|实|是|过|能|要|得|少|到|用|会|靠)|^.{1}[「『（(]/;

/**
 * 从正文 / 备注 / 标题里挑一句 8~30 字、以动词开头的「动作」。
 * 逐字返回（只在首尾去空白），保证是原文子串；挑不出来时退回标题的第一个从句。
 */
function extractAction(title, body, gain, note, costNote) {
  const bad = (p) => BAD_TAIL.test(p) || LEGAL_TEXT.test(p) || BAD_OPENING.test(p);
  // 1) 标题优先：这本书的标题就是作者写好的行动句，只按 [，：] 切，别切坏括号里的顿号列表
  const titleParts = String(title || '').split(/[，：]/).map((s) => s.trim()).filter(Boolean);
  let bestTitle = null;
  for (const p of titleParts) {
    if (bad(p)) continue;
    if (p.length > 26) continue;   // 太长的从句在截断阶段处理
    const v = (p.length >= 5 ? 2 : 0)
      + (ACTION_START.some((w) => p.startsWith(w)) ? 2 : 0)
      + (/[不别要先必应]/.test(p) ? 1 : 0);
    if (!bestTitle || v > bestTitle.v) bestTitle = { v, p };
  }
  if (bestTitle && bestTitle.v >= 2) return clip(bestTitle.p, 26);

  // 2) 正文补充：必须是动词开头的完整短句，且不含风险/比例这类解释性表述
  let best = null;
  for (const sentence of String(body || '').split(/[。；！？\n]/)) {
    for (const part of sentence.split(/[，、：]/)) {
      const p = part.trim();
      if (!p || p.length < 8 || p.length > 26) continue;
      if (!ACTION_START.some((w) => p.startsWith(w))) continue;
      if (bad(p)) continue;
      if (/风险|概率|比例|增加|上升|下降|低于|高于|万人|百分之|以上|以下/.test(p)) continue; // 解释性语句
      if (/每(天|周|月|年)?多|每多|越多|越少|越高|越低/.test(p)) continue;                    // 相对风险的说法，方向会反
      const v = 5 + (p.length <= 24 ? 2 : 0);
      if (!best || v > best.v) best = { v, p };
    }
  }
  if (best) return best.p;
  return clip(String(title || ''), 26);
}

/** 截断到 n 个字符，去掉尾部标点并补省略号（保证仍是原文子串加上省略号）。 */
function clip(text, n) {
  const chars = [...String(text || '')];
  if (chars.length <= n) return chars.join('');
  return chars.slice(0, n).join('').replace(/[、，：·；]+$/, '') + '…';
}


/* ------------------------------------------------------------------ *
 * 3. 转成前端要用的扁平结构
 * ------------------------------------------------------------------ */
function toItems(chapter) {
  const nn = String(chapter.section).padStart(2, '0');
  return chapter.entries.map((e, i) => ({
    id: `${nn}-${String(i + 1).padStart(2, '0')}`,
    section: chapter.section,
    section_name: chapter.section_name,
    index_in_section: i + 1,
    title: e.title,
    cost_money: costTier(e.money, 'money'),
    cost_time: costTier(e.time, 'time'),
    cost_grit: costTier(e.will, 'will'),
    benefit_level: ['大', '中', '小'].includes(e.level) ? e.level : '中',
    evidence: ['A', 'B', 'C'].includes(e.grade) ? e.grade : 'C',
    source: e.src,
    body: e.human || e.gain || e.cost,
    // —— 以下为 UI 增强字段，不影响排序口径 ——
    action_tag: actionTag(chapter.section_name, [e.title, e.human, e.gain].join(' ')),
    action_text: extractAction(e.title, e.human, e.gain, e.note, e.cost),
    gain: e.gain,
    cost_note: e.cost,
    note: e.note,
    lens: e.lens,
  }));
}

/* ------------------------------------------------------------------ *
 * 4. 构建：把 JSON 注入模板，生成可双击打开的单文件 index.html
 * ------------------------------------------------------------------ */
function buildHtml(jsonPath, templatePath, outPath, items) {
  const tpl = fs.readFileSync(templatePath, 'utf8');
  const BEGIN = '/* __DATA_BEGIN__ */';
  const END = '/* __DATA_END__ */';
  const i = tpl.indexOf(BEGIN);
  const j = tpl.indexOf(END);
  if (i < 0 || j < 0) throw new Error(`模板缺少 ${BEGIN} / ${END} 标记`);

  const payload = JSON.stringify(items)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const html =
    tpl.slice(0, i + BEGIN.length) +
    '\nconst ITEMS = ' + payload + ';\n' +          // 数据直接内联，file:// 下无跨域问题
    tpl.slice(j);

  fs.writeFileSync(outPath, html);
  return Buffer.byteLength(html);
}

/* ------------------------------------------------------------------ *
 * 5. CLI
 * ------------------------------------------------------------------ */
function main() {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  const root = __dirname;
  const bookDir = path.resolve(root, opt('book', 'src/book'));
  const outJson = path.resolve(root, opt('out', 'data.json'));
  const template = path.resolve(root, opt('template', 'src/template.html'));
  const outHtml = path.resolve(root, opt('html', 'index.html'));
  const noBuild = argv.includes('--no-build');

  const files = fs.readdirSync(bookDir).filter((f) => /^\d+.*\.md$/.test(f)).sort();
  if (!files.length) {
    console.error(`✗ ${bookDir} 下没有找到 NN-*.md`);
    process.exit(1);
  }

  const items = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(bookDir, f), 'utf8');
    const chapter = parseChapter(text, Number((f.match(/^(\d+)/) || [0, 0])[1]));
    const rows = toItems(chapter);
    items.push(...rows);
    console.log(`  ${f.padEnd(34, ' ')} ${String(rows.length).padStart(3)} 条   §${chapter.section} ${chapter.section_name}`);
  }

  // 统计：确保覆盖到不同档位 / 收益 / 证据等级
  const tally = (fn) => items.reduce((m, it) => (m[fn(it)] = (m[fn(it)] || 0) + 1, m), {});
  const stats = {
    条目总数: items.length,
    章节数: new Set(items.map((i) => i.section)).size,
    钱: tally((i) => i.cost_money),
    时间: tally((i) => i.cost_time),
    毅力: tally((i) => i.cost_grit),
    收益: tally((i) => i.benefit_level),
    证据: tally((i) => i.evidence),
  };

  fs.writeFileSync(outJson, JSON.stringify(items, null, 1));
  console.log('\n统计：', JSON.stringify(stats));
  console.log(`✓ 写出 ${path.relative(root, outJson)}（${(fs.statSync(outJson).size / 1024).toFixed(0)} KB，${items.length} 条）`);

  if (!noBuild && fs.existsSync(template)) {
    const bytes = buildHtml(outJson, template, outHtml, items);
    console.log(`✓ 写出 ${path.relative(root, outHtml)}（${(bytes / 1024).toFixed(0)} KB，单文件、零依赖）`);
  }
}

if (require.main === module) main();

module.exports = { parseChapter, toItems, costTier, COST_W };
