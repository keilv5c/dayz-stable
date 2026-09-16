/* ============================================================================
 * mdz_chunk_guard.test.js —— 分块重组器的资源上限（P1-1 回归测试）
 * ----------------------------------------------------------------------------
 * 背景：分块信封里的字段（尤其 meta.t = 分块总数）全部由对端控制。
 *   早期实现直接 new Array(meta.t)，且 buffers 没有任何并发/总量上限 ——
 *   对端只要不停换 id 发分块、或报一个很大的 t，就能把接收方内存撑爆
 *   （联机时房主是被动接收方，是最容易被打的一方）。
 *
 * 本套件钉住的四条闸门：
 *   maxParts      单组分片数上限（t 必须落在 [1, maxParts]）
 *   maxGroupBytes 单组累计字符上限
 *   maxPending    同时在收的分块组数上限（超出淘汰最旧的）
 *   maxTotalBytes 所有组累计字符上限（超出淘汰最旧的）
 * 以及：超时组会被清理、同 id 换 t 视为伪造、统计里能看到 dropped。
 *
 * 运行：node test/mdz_chunk_guard.test.js
 * ==========================================================================*/
'use strict';
const Core = require('../web/mdz_core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function eq(name, a, b) { ok(name, a === b, a === b ? '' : 'got=' + JSON.stringify(a).slice(0, 90) + ' want=' + JSON.stringify(b).slice(0, 90)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async function main() {
  /* ----------------------------------------------- 1. 正常路径不能被误伤 */
  section('1. 正常分块仍然完整还原（回归）');

  const big = JSON.stringify({ type: 'map_data', blob: 'A'.repeat(50000), tail: '结束😀' });
  const chunks = Core.makeChunks(big, 7);
  ok('大消息被切成多块', chunks.length > 1, chunks.length + ' 块');

  const ra0 = new Core.ChunkReassembler();
  let got0 = null;
  for (const c of chunks) got0 = ra0.push(c.__mdz, c.d) || got0;
  eq('默认上限下 50KB 消息可还原', got0, big);
  eq('还原后没有残留组', ra0.stats().pending, 0);
  eq('正常路径没有丢弃', ra0.stats().dropped, 0);
  eq('还原后累计字节归零', ra0.stats().bytes, 0);

  /* ---------------------------------------------------- 2. 信封形状校验 */
  section('2. 非法信封必须被拒（t / i / id 全部由对端控制）');

  const ra1 = new Core.ChunkReassembler();
  eq('meta 为 null', ra1.push(null, 'x'), null);
  eq('meta 不是对象', ra1.push('t=2', 'x'), null);
  eq('id 类型非法', ra1.push({ id: {}, i: 0, t: 2 }, 'x'), null);
  eq('id 为空串', ra1.push({ id: '', i: 0, t: 2 }, 'x'), null);
  eq('t 为 0', ra1.push({ id: 1, i: 0, t: 0 }, 'x'), null);
  eq('t 为负', ra1.push({ id: 1, i: 0, t: -3 }, 'x'), null);
  eq('t 非整数', ra1.push({ id: 1, i: 0, t: 2.5 }, 'x'), null);
  eq('t 是字符串', ra1.push({ id: 1, i: 0, t: '2' }, 'x'), null);
  eq('t 超过 maxParts', ra1.push({ id: 1, i: 0, t: Core.CHUNK_LIMITS.maxParts + 1 }, 'x'), null);
  eq('i 越界（>= t）', ra1.push({ id: 1, i: 2, t: 2 }, 'x'), null);
  eq('i 为负', ra1.push({ id: 1, i: -1, t: 2 }, 'x'), null);
  eq('data 不是字符串', ra1.push({ id: 1, i: 0, t: 2 }, { not: 'a string' }), null);
  ok('非法信封计入 dropped', ra1.stats().dropped >= 12, 'dropped=' + ra1.stats().dropped);
  eq('非法信封不会占住缓冲区', ra1.stats().pending, 0);
  ok('isValidChunkMeta 对合法信封返回 true', Core.isValidChunkMeta({ id: 3, i: 1, t: 4 }, 256) === true);
  ok('isValidChunkMeta 对 t 超限返回 false', Core.isValidChunkMeta({ id: 3, i: 0, t: 9999 }, 256) === false);

  /* -------------------------------------------------- 3. 并发组数上限 */
  section('3. 并发分块组数量必须封顶（防"换 id 洪水"）');

  const ra2 = new Core.ChunkReassembler({ maxPending: 3 });
  for (let id = 1; id <= 40; id++) {
    ra2.push({ id: id, i: 0, t: 2 }, 'x'.repeat(10));   // 永远不补齐，模拟洪水
  }
  eq('pending 不超过 maxPending', ra2.stats().pending <= 3, true);
  eq('pending 恰好停在 3', ra2.stats().pending, 3);
  ok('被淘汰的组计入 dropped', ra2.stats().dropped >= 37, 'dropped=' + ra2.stats().dropped);

  /* ---------------------------------------------------- 4. 总量字节上限 */
  section('4. 累计字节必须封顶（防"大块洪水"）');

  const ra3 = new Core.ChunkReassembler({ maxTotalBytes: 1000, maxGroupBytes: 1000 });
  ra3.push({ id: 'a', i: 0, t: 2 }, 'A'.repeat(600));
  ra3.push({ id: 'b', i: 0, t: 2 }, 'B'.repeat(600));
  ok('累计字节不超过 maxTotalBytes', ra3.stats().bytes <= 1000, 'bytes=' + ra3.stats().bytes);
  eq('旧组被淘汰、新组留下', ra3.stats().pending, 1);
  ok('淘汰计入 dropped', ra3.stats().dropped >= 1, 'dropped=' + ra3.stats().dropped);

  const ra4 = new Core.ChunkReassembler({ maxGroupBytes: 500 });
  eq('单块超过 maxGroupBytes 直接拒', ra4.push({ id: 1, i: 0, t: 2 }, 'Z'.repeat(501)), null);
  eq('被拒后不占缓冲区', ra4.stats().pending, 0);

  const ra5 = new Core.ChunkReassembler({ maxGroupBytes: 800 });
  ra5.push({ id: 1, i: 0, t: 4 }, 'Z'.repeat(500));
  eq('同组累计超 maxGroupBytes 时整组作废', ra5.push({ id: 1, i: 1, t: 4 }, 'Z'.repeat(500)), null);
  eq('作废后组被清掉', ra5.stats().pending, 0);

  /* -------------------------------------------------------- 5. 超时清理 */
  section('5. 超时组必须被清理（不能只靠"同 id 再来一块"触发）');

  const ra6 = new Core.ChunkReassembler({ timeoutMs: 1 });
  ra6.push({ id: 'stale', i: 0, t: 2 }, 'old');
  await sleep(20);
  ra6.push({ id: 'fresh', i: 0, t: 2 }, 'new');
  eq('超时组在下一次 push 时被清扫', ra6.stats().pending, 1);
  ok('清扫计入 dropped', ra6.stats().dropped >= 1, 'dropped=' + ra6.stats().dropped);
  eq('留下的是新组', Object.keys(ra6.buffers)[0], 'fresh');

  /* ----------------------------------------------- 6. 同 id 换分块方案 */
  section('6. 同一个 id 换了 t 视为伪造，旧组作废');

  const ra7 = new Core.ChunkReassembler();
  ra7.push({ id: 9, i: 0, t: 3 }, 'first');
  eq('换 t 后返回 null（旧组已作废）', ra7.push({ id: 9, i: 1, t: 2 }, 'second'), null);
  eq('旧组被清掉、新组重建', ra7.stats().pending, 1);
  eq('新组的 total 是新的 t', ra7.buffers[9].total, 2);

  /* ------------------------------------------- 7. 上限可配置且不为 0 卡死 */
  section('7. 上限可配置，且不会被 0/负数搞成死循环');

  const ra8 = new Core.ChunkReassembler({ maxPending: 0, maxParts: 0, maxGroupBytes: 0, maxTotalBytes: 0 });
  ok('maxPending 至少为 1', ra8.maxPending >= 1, 'maxPending=' + ra8.maxPending);
  ok('maxParts 至少为 1', ra8.maxParts >= 1, 'maxParts=' + ra8.maxParts);
  ok('maxGroupBytes 至少为 1', ra8.maxGroupBytes >= 1, 'maxGroupBytes=' + ra8.maxGroupBytes);
  ok('maxTotalBytes 至少为 1', ra8.maxTotalBytes >= 1, 'maxTotalBytes=' + ra8.maxTotalBytes);
  eq('极端配置下单块消息仍能返回', ra8.push({ id: 1, i: 0, t: 1 }, 'done'), 'done');

  // 显式传入的小上限必须被尊重（早期版本给 maxGroupBytes/maxTotalBytes 加了 1024 的下限，
  // 会把调用方明确指定的 500 悄悄改成 1024 —— 这条断言就是防它再回来）
  const ra9 = new Core.ChunkReassembler({ maxGroupBytes: 500 });
  eq('显式的小上限被尊重', ra9.maxGroupBytes, 500);

  /* ----------------------------------------------------- 8. 导出与统计 */
  section('8. 常量与统计字段已导出');

  ok('CHUNK_LIMITS 已导出', !!Core.CHUNK_LIMITS);
  ok('isValidChunkMeta 已导出', typeof Core.isValidChunkMeta === 'function');
  const st = new Core.ChunkReassembler().stats();
  ok('stats 含 bytes 字段', typeof st.bytes === 'number');
  ok('stats 含 dropped 字段', typeof st.dropped === 'number');
  ok('stats 含 pending / parts 字段', typeof st.pending === 'number' && typeof st.parts === 'number');

  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
