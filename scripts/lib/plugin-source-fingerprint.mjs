/**
 * 插件「源码内容指纹」—— 单一实现，供构建侧与门禁侧共用
 *
 * 为什么存在（Phase 10 · §6 #4）：
 *   `verify-config.mjs` 原来用 **mtime** 判断"源码是否比产物新"：
 *       源码树里最大的 mtimeMs <= 产物 mtimeMs  ⇒ 判定同步
 *   mtime 不是内容，它在两个方向上都会说谎：
 *     · **假红**：`git checkout` / `cp` / `touch` / 重新 clone 都会刷新 mtime，
 *       内容一个字节没变，门禁却要求"请重新 build" —— 真信号被噪声淹没，
 *       久而久之所有人学会无视这条断言。
 *     · **假绿（更危险）**：从备份 / `tar -p` / `rsync -a` 回灌的源码**保留原 mtime**，
 *       于是源码其实已经变了、产物还是旧的，门禁却说"已同步"。
 *   ⇒ 判据必须落在**内容**上，而不是文件的元数据上。
 *
 * 为什么必须"构建时写进产物"而不是"门禁时现算"：
 *   光看当前源码的内容，推不出产物是不是由它编出来的 ——
 *   缺少一个"产物当时对应的源码长什么样"的记录。
 *   所以由 `scripts/build-plugin.mjs` 在构建末尾把指纹写进产物目录，
 *   门禁只负责"重算当前源码指纹 == 产物里记录的指纹"。
 *
 * ⚠️ "什么算源码"必须只有**一处定义**（本项目铁律：同一个坑不要有两条腿）。
 *    构建侧与门禁侧都调 `fingerprintPluginSource()`，不各自 walk 目录。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FINGERPRINT_VERSION = 1;
export const FINGERPRINT_ALGORITHM = 'sha256';

/** 指纹清单相对插件产物目录的位置 */
export const MANIFEST_RELPATH = 'dist/build-fingerprint.json';

/** 参与指纹的源码范围（唯一定义） */
function sourceEntries(pluginDir) {
  const out = [];
  const srcDir = path.join(pluginDir, 'src');

  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  walk(srcDir);

  // package.json 会被原样拷进产物（NocoBase 靠它识别插件 / 定入口 / 读版本号），
  // 它变了而 src 没变 ⇒ 产物同样必须重建。旧版 mtime 判据**漏掉了它**。
  const pkg = path.join(pluginDir, 'package.json');
  if (fs.existsSync(pkg)) out.push(pkg);

  return out.sort();
}

function sha256File(abs) {
  return crypto.createHash(FINGERPRINT_ALGORITHM).update(fs.readFileSync(abs)).digest('hex');
}

/**
 * 计算插件源码树的内容指纹。
 * @returns {{version:number, algorithm:string, digest:string, fileCount:number, files:Record<string,string>}}
 */
export function fingerprintPluginSource(pluginDir) {
  const abs = path.resolve(pluginDir);
  const files = {};
  for (const file of sourceEntries(abs)) {
    // 相对路径统一用 `/`：Windows 与 Linux 算出的指纹必须一致，
    // 否则"在 Windows 构建、在容器里校验"会无条件不一致。
    files[path.relative(abs, file).split(path.sep).join('/')] = sha256File(file);
  }
  const names = Object.keys(files).sort();
  const canonical = names.map((n) => `${n}\t${files[n]}`).join('\n');
  return {
    version: FINGERPRINT_VERSION,
    algorithm: FINGERPRINT_ALGORITHM,
    digest: crypto.createHash(FINGERPRINT_ALGORITHM).update(canonical).digest('hex'),
    fileCount: names.length,
    files,
  };
}

/** 比较两个指纹，给出人类可读的差异（新增 / 删除 / 内容变化） */
export function diffFingerprints(current, recorded) {
  const cur = current.files || {};
  const rec = (recorded && recorded.files) || {};
  const added = [];
  const removed = [];
  const changed = [];
  for (const name of Object.keys(cur)) {
    if (!(name in rec)) added.push(name);
    else if (rec[name] !== cur[name]) changed.push(name);
  }
  for (const name of Object.keys(rec)) if (!(name in cur)) removed.push(name);
  return { added, removed, changed };
}

/**
 * 指纹原语的**自检** —— 证明它真的在比内容、而不是在比元数据。
 *
 * 这是"验证器本身必须可以被验证"的落地：门禁里若少了这三条，
 * 本模块万一退化成"恒返回同一个值"，那条同步断言会安静地永远绿。
 */
export function selfTestFingerprint() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `fp-selftest-${process.pid}-`));
  const results = [];
  try {
    const mk = (name, content) => {
      const dir = path.join(base, name);
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), content);
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
      return dir;
    };

    const same1 = mk('same1', 'export const a = 1;');
    const same2 = mk('same2', 'export const a = 1;');
    const differs = mk('differs', 'export const a = 2;');

    // ① 内容相同 ⇒ 指纹相同（哪怕是两个独立创建的目录）
    const f1 = fingerprintPluginSource(same1);
    const f2 = fingerprintPluginSource(same2);
    results.push(['两个独立创建但内容相同的源码树 ⇒ 指纹相同', f1.digest === f2.digest]);

    // ② 内容不同 ⇒ 指纹不同
    const f3 = fingerprintPluginSource(differs);
    results.push(['内容不同的源码树 ⇒ 指纹不同', f1.digest !== f3.digest]);

    // ③ 关键：只改 mtime（内容不动）⇒ 指纹不变 —— 这正是旧判据说谎的地方
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    fs.utimesSync(path.join(same1, 'src', 'a.ts'), old, old);
    const f4 = fingerprintPluginSource(same1);
    results.push(['只改 mtime（内容未动）⇒ 指纹不变', f1.digest === f4.digest]);

    // ④ diff 能定位到具体文件
    const d = diffFingerprints(f3, f1);
    results.push(['差异可定位到具体文件', d.changed.length === 1 && d.changed[0] === 'src/a.ts']);

    // ⑤ 反向自检：检测正则/逻辑若失效，上面②③应当不再成立 ⇒ 这里确认比较逻辑真的在跑
    results.push(['自检样本非零（指纹确实算出了文件）', f1.fileCount === 2]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  return results;
}
