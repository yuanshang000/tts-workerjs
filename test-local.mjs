/**
 * 本地验证脚本：在 Node 22 中直接调用 worker.js 的合成函数，
 * 真实连接微软 Edge TTS 服务器，验证协议实现。
 * 用法：NODE_PATH=... node test-local.mjs
 */
import { writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { synthesizeText, VOICES, setWebSocketFactory } from "./worker.js";

// 注入 ws 库作为 WebSocket 工厂（支持自定义握手头，等价于 Workers 的 fetch+Upgrade）
const require = createRequire(import.meta.url);
const WS = require("ws");
setWebSocketFactory((url, headers) => {
  const sock = new WS(url, { headers });
  return {
    binaryType: "arraybuffer",
    accept: () => {}, // 兼容 Workers fetch-WebSocket 的 accept 时序（ws 库自动握手）
    send: (d) => sock.send(d),
    close: () => { try { sock.close(); } catch (_) {} },
    addEventListener: (ev, fn) => {
      if (ev === "message") {
        sock.on("message", (data, isBinary) => {
          fn({ type: "message", data: isBinary ? toArrayBuffer(data) : data.toString() });
        });
      } else if (ev === "close") {
        sock.on("close", (code, reason) => fn({ type: "close", code, reason: reason.toString() }));
      } else if (ev === "error") {
        sock.on("error", (err) => fn({ type: "error", message: err && err.message }));
      } else if (ev === "open") {
        sock.on("open", () => fn({ type: "open" }));
      }
    },
  };
});

function toArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) return buf;
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return ab;
}

const OUT = "./test-output";
mkdirSync(OUT, { recursive: true });

function checkAudio(path, expect) {
  const st = statSync(path);
  const head = readFileSync(path).subarray(0, 12);
  const hex = [...head].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const ascii = [...head].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
  let magicOk = false;
  if (expect === "mp3") {
    magicOk = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33 // "ID3"
      || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);              // 裸帧头
  } else if (expect === "wav") {
    magicOk = ascii.slice(0, 4) === "RIFF" && ascii.slice(8, 12) === "WAVE";
  }
  const sizeOk = st.size > 8000;
  console.log(`  文件: ${path}`);
  console.log(`  大小: ${st.size} 字节 (${(st.size / 1024).toFixed(1)} KB)`);
  console.log(`  头部: ${hex}`);
  console.log(`  校验: magic=${magicOk ? "PASS" : "FAIL"} size=${sizeOk ? "PASS" : "FAIL"}`);
  return magicOk && sizeOk;
}

let failed = 0;

// ---- 用例 1：短文本 MP3（晓晓）----
console.log("\n[用例1] 短文本 MP3 / xiaoxiao（默认语速）");
try {
  const t0 = Date.now();
  const r = await synthesizeText({
    text: "你好，世界。这是一段用于验证 Cloudflare Workers 版 Edge TTS 协议的测试语音。",
    voice: "xiaoxiao",
    format: "mp3",
  });
  const f = `${OUT}/case1-xiaoxiao.mp3`;
  writeFileSync(f, r.audio);
  console.log(`  耗时: ${Date.now() - t0} ms`);
  if (!checkAudio(f, "mp3")) failed++;
} catch (e) {
  console.log("  FAIL:", e.message);
  failed++;
}

// ---- 用例 2：语速/音调参数（云希）+ WAV 参数校验 ----
console.log("\n[用例2] yunxi / rate=+20% pitch=-5Hz volume=+30%（MP3）");
try {
  const r = await synthesizeText({
    text: "语速调快百分之二十，音调降低五赫兹，音量加大百分之三十。",
    voice: "yunxi",
    format: "mp3",
    rate: "+20%",
    pitch: "-5Hz",
    volume: "+30%",
  });
  const f = `${OUT}/case2-yunxi.mp3`;
  writeFileSync(f, r.audio);
  if (!checkAudio(f, "mp3")) failed++;
} catch (e) {
  console.log("  FAIL:", e.message);
  failed++;
}
console.log("[用例2b] format=wav 应返回明确提示（服务端仅 MP3，WAV 由前端导出）");
try {
  await synthesizeText({ text: "测试", voice: "xiaoxiao", format: "wav" });
  console.log("  FAIL: 竟然成功了？");
  failed++;
} catch (e) {
  const ok = /WAV 请在网页端导出/.test(e.message);
  console.log(`  提示: ${e.message}`);
  console.log(`  校验: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) failed++;
}

// ---- 用例 3：长文本分块 + 真字幕（Ava 英文，替代已下线的 Amy）----
console.log("\n[用例3] 长文本分块合成 + SRT 字幕（ava 英文）");
try {
  const longText = [
    "Artificial intelligence is transforming the way we build software.",
    "Cloudflare Workers lets developers deploy code to hundreds of cities around the world.",
    "This project ports the Microsoft Edge text to speech engine to a single JavaScript file.",
    "It supports multiple voices, adjustable rate, pitch, volume, and real subtitles generated from word boundaries.",
    "Everything runs on the edge, with no servers to maintain.",
  ].join(" ");
  const t0 = Date.now();
  const r = await synthesizeText({
    text: longText,
    voice: "ava",
    format: "mp3",
    subtitles: true,
  });
  const f = `${OUT}/case3-ava.mp3`;
  writeFileSync(f, r.audio);
  writeFileSync(`${OUT}/case3-ava.srt`, r.srt || "(no srt)");
  console.log(`  耗时: ${Date.now() - t0} ms`);
  console.log(`  字幕条目数: ${(r.srt || "").split("\n\n").filter(Boolean).length}`);
  if (!checkAudio(f, "mp3")) failed++;
  const srtOk = r.srt && r.srt.includes("-->") && r.srt.includes("00:00:");
  console.log(`  SRT 校验: ${srtOk ? "PASS" : "FAIL"}`);
  if (!srtOk) failed++;
  console.log("  字幕预览:\n" + (r.srt || "").split("\n").slice(0, 8).join("\n"));
} catch (e) {
  console.log("  FAIL:", e.message);
  failed++;
}

// ---- 用例 4：超长中文分块（3 块）----
console.log("\n[用例4] 中文长文本分块（约 1500 字，应切为 2 块）");
try {
  const t0 = Date.now();
  const r = await synthesizeText({
    text: "春江潮水连海平，海上明月共潮生。滟滟随波千万里，何处春江无月明。".repeat(46),
    voice: "xiaoxiao",
    format: "mp3",
  });
  const f = `${OUT}/case4-long-cn.mp3`;
  writeFileSync(f, r.audio);
  console.log(`  耗时: ${Date.now() - t0} ms`);
  if (!checkAudio(f, "mp3")) failed++;
} catch (e) {
  console.log("  FAIL:", e.message);
  failed++;
}

console.log("\n========================================");
console.log(failed === 0 ? "全部用例通过 ✓" : `${failed} 个用例失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
