#!/usr/bin/env node
/**
 * 打包脚本：把插件目录打成宿主可安装的 plugin.zip，并产出 sha256 与 release notes。
 *
 * 为什么要自己打而不是 `zip -r .`：
 *   1. 文件清单必须与 manifest 声明的入口严格对应，多一个少一个都可能在审核抽查时暴露；
 *   2. 必须保证 ZIP **顶层就是 manifest.json**（宿主 installFromZip 的解析顺序：
 *      顶层有 manifest.json → 用顶层；否则找唯一顶层目录里有没有 manifest.json）；
 *      源码目录名（如 pet-plugin-todo-reminder/）不能出现在 ZIP 里，否则多一层目录；
 *   3. 内容排序固定 → 同样的源码打出同样的包，便于复算摘要；
 *   4. 产物可复现：文件 mtime 归零，避免每次构建摘要都变。
 *
 * 用法：
 *   node scripts/build.js                       # 构建 dist/plugin.zip
 *   node scripts/build.js --check-only          # 只校验，不产出
 *   node scripts/build.js --check-tag v1.0.2    # 额外校验 tag 与 manifest.version 一致
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// ZIP 里必须包含的文件清单（manifest 声明的入口 + 资源 + 说明文档）
const INCLUDE_FILES = [
  'manifest.json',
  'README.md',
  'LICENSE',
  'tool/index.js',
  'panel/panel.html',
  'card/card.html'
];

const INCLUDE_DIRS = [];   // 本插件没有需要整目录打包的资源

const ZIP_NAME = 'plugin.zip';

function parseArgs(argv) {
  const out = { checkOnly: false, checkTag: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check-only') out.checkOnly = true;
    else if (argv[i] === '--check-tag') out.checkTag = argv[++i] || '';
  }
  return out;
}

// ---- 收集文件清单（排序固定，保证可复现） ----
function collectFiles() {
  const files = [];
  for (const rel of INCLUDE_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error('缺少必需文件: ' + rel);
    files.push(rel);
  }
  for (const dir of INCLUDE_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) throw new Error('缺少必需目录: ' + dir);
    const walk = (base, prefix) => {
      for (const name of fs.readdirSync(base).sort()) {
        const full = path.join(base, name);
        const rel = prefix ? prefix + '/' + name : name;
        if (fs.statSync(full).isDirectory()) walk(full, rel);
        else files.push(rel);
      }
    };
    walk(abs, dir);
  }
  return files.sort();
}

// ---- 校验 manifest ----
function validateManifest() {
  const manifestPath = path.join(ROOT, 'manifest.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const m = JSON.parse(raw);

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(m.id) || m.id.includes('..')) {
    throw new Error('manifest.id 不合法: ' + m.id);
  }
  if (!/^\d+\.\d+\.\d+$/.test(m.version)) {
    throw new Error('manifest.version 必须是 x.y.z: ' + m.version);
  }
  if (!m.description || typeof m.description !== 'string') {
    throw new Error('manifest.description 缺失');
  }
  if (m.description.includes('\n')) {
    throw new Error('manifest.description 必须是单行纯文本');
  }
  const cps = [...m.description].length;
  if (cps > 200) {
    throw new Error('manifest.description 超过 200 个 Unicode 码点: ' + cps);
  }
  if (!Array.isArray(m.permissions) || !m.permissions.length) {
    throw new Error('manifest.permissions 缺失');
  }
  for (const p of m.permissions) {
    if (p === 'net') throw new Error('net 权限必须逐域名写成 net:<hostname>');
  }
  if (m.kind.includes('tool') && !m.entry?.tool) throw new Error('kind 含 tool 时 entry.tool 必填');
  if (m.kind.includes('panel') && !m.entry?.panel?.src) throw new Error('kind 含 panel 时 entry.panel.src 必填');
  if (m.kind.includes('dashboard-card') && !m.entry?.dashboardBlock?.src) {
    throw new Error('kind 含 dashboard-card 时 entry.dashboardBlock.src 必填');
  }
  return m;
}

// ---- 校验 manifest 声明的入口都在清单里 ----
function validateEntries(manifest, files) {
  const set = new Set(files);
  const need = [];
  if (manifest.entry?.tool) need.push(manifest.entry.tool);
  if (manifest.entry?.panel?.src) need.push(manifest.entry.panel.src);
  if (manifest.entry?.dashboardBlock?.src) need.push(manifest.entry.dashboardBlock.src);
  if (manifest.entry?.character) need.push(manifest.entry.character);
  for (const rel of need) {
    if (!set.has(rel)) {
      throw new Error('manifest 声明的入口不在打包清单里: ' + rel);
    }
  }
}

// ---- 政策自检：Node 内建模块 / 动态 require / eval / 联网 ----
function policyScan(files) {
  const BUILTIN = /require\(\s*['"](fs|path|child_process|net|http|https|os|crypto|worker_threads|vm|zlib|stream|tls|dgram|cluster|repl|assert|querystring|readline|tty|perf_hooks|async_hooks)['"]\s*\)/;
  const DYNAMIC_REQUIRE = /require\(\s*[^'")\s]/;
  const EVAL = /\beval\s*\(|new\s+Function\s*\(/;
  const NETWORK = /\bfetch\s*\(|XMLHttpRequest|https?:\/\//;

  const problems = [];
  for (const rel of files) {
    if (!/\.(js|html|mjs|cjs)$/.test(rel)) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const at = rel + ':' + (i + 1);
      if (BUILTIN.test(line)) problems.push('Node 内建模块 require: ' + at);
      if (DYNAMIC_REQUIRE.test(line)) problems.push('动态 require: ' + at);
      if (EVAL.test(line)) problems.push('eval / new Function: ' + at);
      if (NETWORK.test(line)) problems.push('联网调用（需 net:<hostname> 声明）: ' + at);
    });
  }
  if (problems.length) {
    throw new Error('政策自检未通过:\n  - ' + problems.join('\n  - '));
  }
}

// ---- 最小 ZIP 写入器（store/deflate，无第三方依赖） ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  // >>> 0 把它转成无符号 32 位；否则 writeUInt32LE 会因为负值越界报错
  return (c ^ -1) >>> 0;
}

function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    // 内容不比压缩后大就用 store，否则用 deflate
    const useStore = deflated.length >= e.data.length;
    const body = useStore ? e.data : deflated;
    const method = useStore ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flag: UTF-8 名称
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);           // mod time（归零，内容固定）
    local.writeUInt16LE(0x21, 12);        // mod date（1980-01-01，归零）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);             // version made by
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);             // extra len
    cen.writeUInt16LE(0, 32);             // comment len
    cen.writeUInt16LE(0, 34);             // disk number
    cen.writeUInt16LE(0, 36);             // internal attrs
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs（普通文件 0644）
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---- 主流程 ----
function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = validateManifest();
  const files = collectFiles();

  validateEntries(manifest, files);
  policyScan(files);

  if (args.checkTag) {
    const expect = 'v' + manifest.version;
    if (args.checkTag !== expect) {
      throw new Error(`标签 ${args.checkTag} 与 manifest.version ${manifest.version} 不一致（应为 ${expect}）`);
    }
    console.log('标签校验通过: ' + args.checkTag);
  }

  console.log('manifest: ' + manifest.id + ' ' + manifest.version);
  console.log('description (' + [...manifest.description].length + ' 码点): ' + manifest.description);
  console.log('permissions: ' + manifest.permissions.join(', '));
  console.log('打包清单 (' + files.length + ' 个文件):');
  for (const f of files) console.log('  - ' + f);

  if (args.checkOnly) {
    console.log('--check-only：校验通过，未产出产物');
    return;
  }

  const entries = files.map((rel) => ({
    name: rel,
    data: fs.readFileSync(path.join(ROOT, rel))
  }));

  const zip = writeZip(entries);
  fs.mkdirSync(DIST, { recursive: true });
  const zipPath = path.join(DIST, ZIP_NAME);
  fs.writeFileSync(zipPath, zip);

  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  fs.writeFileSync(zipPath + '.sha256', sha + '  ' + ZIP_NAME + '\n');

  const notes = [
    '# 到点提醒 ' + manifest.version,
    '',
    manifest.description,
    '',
    '## 安装',
    '',
    '在桌宠「设置 → 插件中心 → 插件市场」搜索「到点提醒」即可安装；',
    '下载 `plugin.zip` 后也可通过「开发者模式 → 手动安装 → 从文件夹安装」导入解压目录。',
    '',
    '## 校验',
    '',
    '```',
    'sha256: ' + sha,
    '```',
    '',
    '## 权限说明',
    '',
    '- `storage`：待办数据存在插件私有存储，卸载即随之删除。',
    '- `pet`：到点时让桌宠冒泡并播放动作。',
    '- `ui`：打开与关闭插件面板。',
    '- `events`：面板与常驻层之间同步数据变更。',
    '- `scheduler`：每 30 秒巡检到期、每 10 分钟催办、每天 09:00 早间播报。',
    '- `tools`：向宿主 Agent 注册 5 个待办管理工具。',
    '- `dashboard`：在看板挂载本插件的卡片。',
    '',
    '本插件不联网、不读剪贴板、不访问文件系统、不使用 Node 内建模块。',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(DIST, 'release-notes.md'), notes);

  console.log('');
  console.log('已产出:');
  console.log('  ' + path.relative(ROOT, zipPath) + '  (' + zip.length + ' 字节)');
  console.log('  ' + path.relative(ROOT, zipPath) + '.sha256');
  console.log('  dist/release-notes.md');
  console.log('sha256: ' + sha);
}

try {
  main();
} catch (err) {
  console.error('构建失败: ' + (err && err.message ? err.message : err));
  process.exit(1);
}
