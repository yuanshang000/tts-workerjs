/**
 * Edge-TTS Web Interface — Cloudflare Workers 版
 *
 * 原项目：https://github.com/shuo0261/edge-tts-web-interface （Python/Flask 版）
 * 本版本为原项目的重构改版：用 JS 直接实现微软 Edge TTS 的 WebSocket 合成协议
 * （与 python edge-tts 库同协议），无需 Python / ffmpeg / Vosk，
 * 单个 worker.js 即可部署到 Cloudflare Workers。
 *
 * 路由：
 *   GET  /                     网页界面
 *   POST /api/tts?raw=1        直接返回音频二进制（网页用）
 *   POST /api/tts              返回 JSON {result, file_url, srt?}（兼容原版接口风格）
 *   GET  /api/tts?text=...     短文本快捷合成，直接返回音频
 *   GET  /api/voices           返回可用语音列表
 */

// ---------------------------------------------------------------------------
// Edge TTS 协议常量
// ---------------------------------------------------------------------------

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
// Chromium 版本需跟随微软校验（过旧的版本号会 403）
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = "1-" + CHROMIUM_FULL_VERSION;
const WSS_BASE =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const WIN_EPOCH_OFFSET = 11644473600n; // 1601-01-01 到 1970-01-01 的秒数
const MAX_BLOCKS = 40;                 // 分块数上限（约 5 万字）
const CHUNK_TIMEOUT_MS = 60_000;       // 单块合成超时

// 服务器时钟偏差（秒）。403 时从响应 Date 头校正，用于生成有效 token。
let clockSkewSeconds = 0;

/** 微软要求的完整握手头（与 python edge-tts 最新版一致） */
function wssHeaders() {
  const muid = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return {
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" +
      CHROMIUM_MAJOR_VERSION + ".0.0.0 Safari/537.36 Edg/" + CHROMIUM_MAJOR_VERSION + ".0.0.0",
    Cookie: "muid=" + muid + ";",
  };
}

/**
 * WebSocket 连接工厂。
 * - Cloudflare Workers：fetch + Upgrade 头（可携带任意自定义头，绕过浏览器限制）
 * - 本地测试：通过 setWebSocketFactory 注入支持自定义头的实现
 */
let wsFactory = null;
export function setWebSocketFactory(fn) {
  wsFactory = fn;
}

async function connectWS(url, timeoutMs = 20_000) {
  if (wsFactory) return wsFactory(url, wssHeaders());
  let resp;
  try {
    resp = await fetch(url.replace(/^wss:\/\//, "https://"), {
      headers: Object.assign({ Upgrade: "websocket" }, wssHeaders()),
    });
  } catch (e) {
    if (String(e && e.cause && e.cause.code).includes("INVALID")) {
      throw new Error(
        "当前运行环境不支持 fetch + Upgrade 出站 WebSocket。" +
        "部署到 Cloudflare Workers 后可用；本地测试请用 setWebSocketFactory 注入 ws 库。"
      );
    }
    throw new Error("网络请求失败：" + (e && e.message ? e.message : e));
  }
  if (!resp.webSocket) {
    const serverDate = resp.headers.get("Date");
    const err = new Error(
      "WebSocket 握手被拒绝（HTTP " + resp.status + "）" +
      (resp.status === 403 ? "：通常是时钟偏差或 token 校验失败" : "")
    );
    err.status = resp.status;
    err.serverDate = serverDate;
    throw err;
  }
  // 注意：此处不 accept()。必须在 addEventListener 注册完成之后再 accept，
  // 否则 open/message 事件可能在监听器挂上之前派发，导致请求永久挂起。
  return resp.webSocket;
}

/** 403 时用服务器 Date 头校正本地时钟偏差 */
function adjustClockSkew(serverDate) {
  if (!serverDate) return false;
  const server = Date.parse(serverDate);
  if (isNaN(server)) return false;
  clockSkewSeconds = Math.round((server - Date.now()) / 1000);
  return true;
}

// Edge 免费接口仅输出 MP3（48kbps CBR）；WAV 导出由前端 Web Audio API 本地解码完成
const FORMATS = {
  mp3: { outputFormat: "audio-24khz-48kbitrate-mono-mp3", mime: "audio/mpeg", ext: "mp3" },
};

export { VOICES, FORMATS };

const VOICES = [
  { id: "xiaoxiao",   name: "zh-CN-XiaoxiaoNeural",        label: "晓晓 · 女声",            group: "普通话" },
  { id: "xiaoyi",     name: "zh-CN-XiaoyiNeural",          label: "晓伊 · 女声",            group: "普通话" },
  { id: "yunjian",    name: "zh-CN-YunjianNeural",         label: "云健 · 男声",            group: "普通话" },
  { id: "yunxi",      name: "zh-CN-YunxiNeural",           label: "云希 · 男声",            group: "普通话" },
  { id: "yunxia",     name: "zh-CN-YunxiaNeural",          label: "云夏 · 女声",            group: "普通话" },
  { id: "yunyang",    name: "zh-CN-YunyangNeural",         label: "云扬 · 男声（新闻）",     group: "普通话" },
  { id: "xiaobei",    name: "zh-CN-liaoning-XiaobeiNeural",label: "晓北 · 辽宁话（女）",     group: "方言" },
  { id: "xiaoni",     name: "zh-CN-shaanxi-XiaoniNeural",  label: "晓妮 · 陕西话（女）",     group: "方言" },
  { id: "hiugaai",    name: "zh-HK-HiuGaaiNeural",         label: "晓佳 · 粤语（女）",       group: "粤语" },
  { id: "hiumaan",    name: "zh-HK-HiuMaanNeural",         label: "晓曼 · 粤语（女）",       group: "粤语" },
  { id: "wanlung",    name: "zh-HK-WanLungNeural",         label: "云龙 · 粤语（男）",       group: "粤语" },
  { id: "hsiaochen",  name: "zh-TW-HsiaoChenNeural",       label: "晓臻 · 台湾腔（女）",     group: "台湾腔" },
  { id: "hsioayu",    name: "zh-TW-HsiaoYuNeural",         label: "晓雨 · 台湾腔（女）",     group: "台湾腔" },
  { id: "yunjhe",     name: "zh-TW-YunJheNeural",          label: "云哲 · 台湾腔（男）",     group: "台湾腔" },
  { id: "ava",        name: "en-US-AvaNeural",             label: "Ava · 英语（美）",        group: "外语" },
  { id: "andrew",     name: "en-US-AndrewMultilingualNeural", label: "Andrew · 英语（美·多语言）", group: "外语" },
  { id: "nanami",     name: "ja-JP-NanamiNeural",          label: "Nanami · 日语",           group: "外语" },
  { id: "elvira",     name: "es-ES-ElviraNeural",          label: "Elvira · 西班牙语",       group: "外语" },
];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 生成 Sec-MS-GEC 防护 token（与 python edge-tts 的 DRM 算法一致，含时钟偏差校正） */
async function generateSecMsGec() {
  const unix = Math.floor(Date.now() / 1000) + clockSkewSeconds;
  // Windows file time：1601 起的 100ns 数
  const ticks = (BigInt(unix) + WIN_EPOCH_OFFSET) * 10000000n;
  // 向下取整到 5 分钟窗口
  const rounded = ticks - (ticks % 3000000000n);
  const data = new TextEncoder().encode(rounded.toString() + TRUSTED_CLIENT_TOKEN);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** X-Timestamp 头的时间格式 */
function dateToString(d = new Date()) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return (
    days[d.getUTCDay()] + " " + months[d.getUTCMonth()] + " " + p(d.getUTCDate()) + " " +
    d.getUTCFullYear() + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" +
    p(d.getUTCSeconds()) + " GMT+0000 (Coordinated Universal Time)"
  );
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把 "+20%" / "-10%" / "20" / "+10Hz" 规范为微软要求的带符号格式 */
function normParam(v, suffix) {
  const empty = suffix === "Hz" ? "+0Hz" : "+0%";
  if (v === undefined || v === null || String(v).trim() === "") return empty;
  const m = String(v).trim().match(/^([+-]?\d+(?:\.\d+)?)\s*(%|hz)?$/i);
  if (!m) return empty;
  const num = m[1];
  const sign = num.startsWith("+") || num.startsWith("-") ? "" : "+";
  return sign + num + (m[2] ? (m[2].toLowerCase() === "hz" ? "Hz" : "%") : suffix);
}

function resolveVoice(voice) {
  if (!voice) return "zh-CN-XiaoxiaoNeural";
  if (VOICES.some((v) => v.id === voice)) return VOICES.find((v) => v.id === voice).name;
  if (/^[a-z]{2,3}-[A-Z]{2}-.+Neural$/.test(voice)) return voice; // 支持完整 voice 名
  return null;
}

/** 按句子边界把长文本切成 ≤1200 字的块 */
function splitTextIntoChunks(text, maxLen = 1200) {
  const clean = String(text).replace(/\r/g, "").trim();
  if (!clean) return [];
  const out = [];
  let buf = "";
  const pushBuf = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };
  for (const para of clean.split(/\n+/)) {
    if (buf.length + para.length + 1 <= maxLen) {
      buf += (buf ? "\n" : "") + para;
      continue;
    }
    pushBuf();
    // 段落仍超长 → 按句切
    const sentences = para.split(/(?<=[。！？!?；;.…])\s*/);
    for (const s of sentences) {
      if (!s) continue;
      if (buf.length + s.length <= maxLen) {
        buf += s;
      } else {
        pushBuf();
        if (s.length <= maxLen) buf = s;
        else {
          // 单句超长 → 硬切
          for (let i = 0; i < s.length; i += maxLen) out.push(s.slice(i, i + maxLen));
        }
      }
    }
  }
  pushBuf();
  return out;
}

function concatUint8(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** 标准 44 字节 WAV 头（PCM 16bit mono 24kHz） */
function makeWavHeader(dataLen, sampleRate = 24000, channels = 1, bits = 16) {
  const buf = new ArrayBuffer(44);
  const dv = new DataView(buf);
  const w = (pos, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(pos + i, s.charCodeAt(i)); };
  const byteRate = sampleRate * channels * (bits / 8);
  const blockAlign = channels * (bits / 8);
  w(0, "RIFF"); dv.setUint32(4, 36 + dataLen, true); w(8, "WAVE");
  w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true); dv.setUint16(32, blockAlign, true); dv.setUint16(34, bits, true);
  w(36, "data"); dv.setUint32(40, dataLen, true);
  return new Uint8Array(buf);
}

/** 服务端返回的 riff WAV 剥掉 44 字节头得到裸 PCM */
function stripWavHeader(u8) {
  if (u8.length <= 44) return new Uint8Array(0);
  const head = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  const wave = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
  if (head === "RIFF" && wave === "WAVE") return u8.slice(44);
  return u8;
}

/** 用 WordBoundary 时间戳生成真 SRT 字幕 */
function buildSrtFromBoundaries(boundaries) {
  const lines = [];
  let cur = { words: [], start: 0, end: 0, len: 0 };
  const endPunct = /[。！？；：.!?;:]$/;
  const flush = () => {
    if (cur.words.length) {
      lines.push({ text: cur.words.join(""), start: cur.start, end: Math.max(cur.end, cur.start + 1) });
    }
    cur = { words: [], start: 0, end: 0, len: 0 };
  };
  for (const b of boundaries) {
    if (b.type !== "WordBoundary") continue;
    const t = b.text || "";
    const prev = cur.words[cur.words.length - 1] || "";
    const needSpace = /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9(]/.test(t);
    if (cur.words.length === 0) cur.start = b.offset;
    cur.words.push(needSpace ? " " + t : t);
    cur.end = b.offset + b.duration;
    cur.len += t.length;
    if (endPunct.test(t) || cur.len >= 42) flush();
  }
  flush();
  const fmt = (ticks) => {
    const ms = Math.max(0, Math.round(ticks / 10000));
    const p2 = (n) => String(n).padStart(2, "0");
    const p3 = (n) => String(n).padStart(3, "0");
    return p2(Math.floor(ms / 3600000)) + ":" + p2(Math.floor((ms % 3600000) / 60000)) + ":" +
      p2(Math.floor((ms % 60000) / 1000)) + "," + p3(ms % 1000);
  };
  return lines
    .map((l, i) => (i + 1) + "\n" + fmt(l.start) + " --> " + fmt(l.end) + "\n" + l.text + "\n")
    .join("\n");
}

// ---------------------------------------------------------------------------
// 核心合成：单块文本 → 音频 + 词边界元数据
// ---------------------------------------------------------------------------

/** 把服务端 metadata JSON（{Metadata:[{Type,Data:{Offset,Duration,text:{Text}}},...]}）扁平化 */
function flattenMetadata(obj) {
  if (!obj || !Array.isArray(obj.Metadata)) return [];
  return obj.Metadata
    .filter((m) => m && m.Type === "WordBoundary" && m.Data)
    .map((m) => ({
      type: "WordBoundary",
      offset: m.Data.Offset || 0,
      duration: m.Data.Duration || 0,
      text: (m.Data.text && m.Data.text.Text) || "",
    }));
}

function synthOnce(text, voiceName, outputFormat, rate, pitch, volume, secMsGec) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const connectionId = crypto.randomUUID().replace(/-/g, "");
    const url =
      WSS_BASE +
      "?TrustedClientToken=" + TRUSTED_CLIENT_TOKEN +
      "&Sec-MS-GEC=" + secMsGec +
      "&Sec-MS-GEC-Version=" + SEC_MS_GEC_VERSION +
      "&ConnectionId=" + connectionId;

    const audioChunks = [];
    const boundaries = [];
    let settled = false;
    let ws = null;
    let opened = false;

    // 连接打开后发送 speech.config + ssml（防止 open 事件错过：accept 后检查 readyState 兜底）
    const onOpen = () => {
      if (opened) return;
      opened = true;
      const ts = dateToString();
      const configBody = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "true" },
              outputFormat: outputFormat,
            },
          },
        },
      });
      ws.send(
        "X-Timestamp:" + ts + "\r\n" +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" + configBody + "\r\n"
      );
      const ssml =
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        "<voice name='" + voiceName + "'>" +
        "<prosody pitch='" + pitch + "' rate='" + rate + "' volume='" + volume + "'>" +
        escapeXml(text) + "</prosody></voice></speak>";
      ws.send(
        "X-RequestId:" + requestId + "\r\n" +
        "Content-Type:application/ssml+xml\r\n" +
        "X-Timestamp:" + ts + "Z\r\n" +
        "Path:ssml\r\n\r\n" + ssml
      );
    };

    const finish = (ok, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) resolve({ audio: concatUint8(audioChunks), boundaries });
      else {
        try { if (ws) ws.close(); } catch (_) {}
        reject(err || new Error("synth failed"));
      }
    };

    const timer = setTimeout(() => finish(false, new Error("合成超时（60 秒无响应）")), CHUNK_TIMEOUT_MS);

    connectWS(url)
      .then((sock) => {
        ws = sock;
        ws.binaryType = "arraybuffer";

        ws.addEventListener("open", onOpen);

        ws.addEventListener("message", (event) => {
          const data = event.data;
          if (typeof data === "string") {
            const m = data.match(/Path:(\S+)/);
            if (!m) return;
            const path = m[1];
            if (path === "turn.end") {
              if (audioChunks.length > 0) finish(true);
              else finish(false, new Error("服务端未返回音频数据"));
            } else if (path === "audio.metadata") {
              // metadata 可能以文本帧到达：JSON 位于 \r\n\r\n 之后
              const idx = data.indexOf("\r\n\r\n");
              if (idx !== -1) {
                try { boundaries.push(...flattenMetadata(JSON.parse(data.slice(idx + 4)))); } catch (_) {}
              }
            }
            return;
          }
          let raw;
          if (data instanceof ArrayBuffer) raw = new Uint8Array(data);
          else if (ArrayBuffer.isView(data)) raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          else raw = new Uint8Array(data);
          if (raw.length < 2) return;
          const headerLen = (raw[0] << 8) | raw[1];
          const header = new TextDecoder().decode(raw.slice(2, 2 + headerLen));
          const payload = raw.slice(2 + headerLen);
          const pm = header.match(/Path:(\S+)/);
          if (!pm) return;
          const path = pm[1];
          if (path === "audio") {
            if (payload.length > 0) audioChunks.push(payload);
          } else if (path === "audio.metadata") {
            try { boundaries.push(...flattenMetadata(JSON.parse(new TextDecoder().decode(payload)))); } catch (_) {}
          }
        });

        ws.addEventListener("error", (e) => {
          finish(false, new Error("连接微软 TTS 服务失败（可能被临时限制或网络不通）" + (e && e.message ? "：" + e.message : "")));
        });

        ws.addEventListener("close", (event) => {
          // 有音频但没等到 turn.end：宽容接受
          if (audioChunks.length > 0) finish(true);
          else if (!settled) {
            finish(false, new Error("连接被服务端关闭（code=" + (event && event.code) + "），请稍后重试"));
          }
        });

        // 事件监听全部注册完成后再 accept（Workers fetch-WebSocket 的关键时序要求）
        if (ws.accept) ws.accept();
        if (ws.readyState === 1) onOpen(); // 兜底：open 事件若已错过则手动触发
      })
      .catch((e) => finish(false, e));
  });
}

/**
 * 完整合成入口：自动分块、逐块合成、拼接。
 * 返回 { audio: Uint8Array, srt: string|null, format }
 */
export async function synthesizeText(opts) {
  const {
    text,
    voice = "xiaoxiao",
    format = "mp3",
    rate = "+0%",
    pitch = "+0Hz",
    volume = "+0%",
    subtitles = false,
  } = opts;

  const voiceName = resolveVoice(voice);
  if (!voiceName) throw new Error("无效的语音 ID：" + voice);
  const fmt = FORMATS.mp3; // Edge 免费接口仅提供 MP3 输出
  if (format && String(format).toLowerCase() === "wav") {
    throw new Error("WAV 请在网页端导出（浏览器本地解码），服务端仅支持 MP3");
  }
  const blocks = splitTextIntoChunks(text);
  if (blocks.length === 0) throw new Error("请输入要转换的文字");
  if (blocks.length > MAX_BLOCKS) {
    throw new Error("文本过长（上限约 " + (MAX_BLOCKS * 1200) + " 字），请分段合成");
  }

  const logs = [];
  const t0 = Date.now();
  logs.push("文本 " + text.length + " 字，切分为 " + blocks.length + " 块");
  logs.push("语音: " + voiceName + " / 参数 rate=" + normParam(rate, "%") + " pitch=" + normParam(pitch, "Hz") + " volume=" + normParam(volume, "%"));

  const audioParts = [];
  const boundaries = [];
  let blockOffsetTicks = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    let part = null;
    let lastErr = null;
    // 每块最多重试 3 次；403 时按服务器时间校正时钟偏差后重试（与 python edge-tts 一致）
    for (let attempt = 0; attempt < 3; attempt++) {
      const secMsGec = await generateSecMsGec();
      const tb = Date.now();
      try {
        part = await synthOnce(
          block, voiceName, fmt.outputFormat,
          normParam(rate, "%"), normParam(pitch, "Hz"), normParam(volume, "%"),
          secMsGec
        );
        logs.push("块 " + (i + 1) + "/" + blocks.length + " 合成成功（第 " + (attempt + 1) + " 次尝试），耗时 " + (Date.now() - tb) + "ms，音频 " + part.audio.length + " 字节，词边界 " + part.boundaries.length + " 条");
        break;
      } catch (e) {
        lastErr = e;
        logs.push("块 " + (i + 1) + "/" + blocks.length + " 第 " + (attempt + 1) + " 次尝试失败: " + (e && e.message ? e.message : e));
        if (e && e.status === 403 && adjustClockSkew(e.serverDate)) {
          lastErr = new Error("403 已按服务器时间校正时钟偏差，重试中");
          logs.push("已按服务器 Date 头校正时钟偏差 " + clockSkewSeconds + " 秒，重试");
          continue;
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!part) throw (lastErr || new Error("合成失败"));

    // MP3 为 48kbps CBR，按字节数精确计算块时长（6000 字节/秒），用于跨块字幕时间轴补偿
    audioParts.push(part.audio);
    const blockDurationTicks = Math.round((part.audio.length / 6000) * 1e7);
    for (const b of part.boundaries) {
      boundaries.push(Object.assign({}, b, { offset: (b.offset || 0) + blockOffsetTicks }));
    }
    blockOffsetTicks += blockDurationTicks;
  }

  const fullAudio = concatUint8(audioParts);
  logs.push("合成完成: 共 " + fullAudio.length + " 字节（48kbps CBR ≈ " + Math.round(fullAudio.length / 6000) + " 秒），总耗时 " + (Date.now() - t0) + "ms");

  return {
    audio: fullAudio,
    srt: subtitles ? buildSrtFromBoundaries(boundaries) : null,
    format: fmt,
    logs,
  };
}

// ---------------------------------------------------------------------------
// HTTP 处理
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS_HEADERS),
  });
}

function fileNameSafe(name, fallback) {
  const s = String(name || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "");
  return s || fallback;
}

async function handleTTS(request, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ result: "error", message: "仅支持 GET/POST" }, 405);
  }

  let params;
  if (request.method === "POST") {
    const ct = request.headers.get("Content-Type") || "";
    try {
      if (ct.includes("application/json")) {
        params = await request.json();
      } else if (ct.includes("form")) {
        params = Object.fromEntries((await request.formData()).entries());
      } else {
        params = {};
      }
    } catch (_) {
      return jsonResponse({ result: "error", message: "请求体解析失败" }, 400);
    }
    // query 参数可覆盖
    for (const [k, v] of url.searchParams.entries()) params[k] = v;
  } else {
    params = Object.fromEntries(url.searchParams.entries());
  }

  const text = String(params.text || params.ssml || "");
  // raw：POST 需显式 raw=1；GET 默认直接返回音频（浏览器打开即下载），raw=0 可关闭
  const wantRaw = params.raw === "1" || params.raw === "true" || (request.method === "GET" && params.raw !== "0");
  const wantSubtitles = params.subtitles === "1" || params.subtitles === "true" || params.generate_subtitles === "1";
  const format = String(params.format || params.output_format || "mp3").toLowerCase();
  const fileBase = fileNameSafe(params.file_name || params.filename, "edge-tts");

  if (!text.trim()) {
    return jsonResponse({ result: "error", message: "请输入要转换的文字" }, 400);
  }
  if (format !== "mp3" && format !== "wav") {
    return jsonResponse({ result: "error", message: "不支持的输出格式（服务端仅支持 mp3；WAV 请在网页端选择，由浏览器本地解码导出）" }, 400);
  }

  try {
    const { audio, srt, format: fmt, logs } = await synthesizeText({
      text,
      voice: params.voice || "xiaoxiao",
      format,
      rate: params.rate,
      pitch: params.pitch,
      volume: params.volume,
      subtitles: wantSubtitles,
    });
    const logLine = logs.join(" | ").slice(0, 3800);

    const disposition =
      "inline; filename*=UTF-8''" + encodeURIComponent(fileBase + "." + fmt.ext);

    // raw 模式或带字幕时：raw 直接回二进制；带字幕必须回 JSON（音频 base64 + 字幕一起交付）
    if (wantRaw || srt) {
      if (srt) {
        // 带字幕时返回 JSON（音频 base64 + 字幕文本），便于一次性拿到两份产物
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < audio.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, audio.subarray(i, i + CHUNK));
        }
        return jsonResponse({
          result: "success",
          format: fmt.ext,
          audio_base64: btoa(bin),
          srt,
          console: logLine,
          file_url: "(data:audio，前端可直接使用 audio_base64)",
        });
      }
      return new Response(audio, {
        status: 200,
        headers: Object.assign(
          {
            "Content-Type": fmt.mime,
            "Content-Length": String(audio.length),
            "Content-Disposition": disposition,
            "X-Tts-Log": encodeURI(logLine),
          },
          CORS_HEADERS
        ),
      });
    }

    // JSON 模式：兼容原版 /api/tts 的返回结构
    const getParams = new URLSearchParams({ text, voice: params.voice || "xiaoxiao", format });
    getParams.set("rate", normParam(params.rate, "%"));
    getParams.set("pitch", normParam(params.pitch, "Hz"));
    getParams.set("volume", normParam(params.volume, "%"));
    const fileUrl = url.origin + "/api/tts?" + getParams.toString();
    const resp = {
      result: "success",
      file_url: fileUrl,
      file_url_note: "GET 该地址可直接下载音频（适合短文本）；长文本请 POST /api/tts?raw=1 获取二进制音频",
      format: fmt.ext,
      size: audio.length,
      console: logLine,
    };
    if (srt) resp.srt = srt;
    return jsonResponse(resp);
  } catch (e) {
    return jsonResponse(
      { result: "error", message: "语音生成失败：" + (e && e.message ? e.message : String(e)), console: "语音生成失败: " + (e && e.message ? e.message : String(e)) },
      500
    );
  }
}

// ---------------------------------------------------------------------------
// 前端页面（单文件内嵌）
// ---------------------------------------------------------------------------

function renderIndex() {
  const voicesJson = JSON.stringify(VOICES);
  const html = [
'<!DOCTYPE html>',
'<html lang="zh-CN">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<title>Edge TTS 在线 · 文字转语音</title>',
'<style>',
':root{--bg:#f4f6f9;--card:#ffffff;--text:#1c2230;--muted:#69748c;--line:#e5e9f2;--accent:#2563eb;--accent-h:#1d4fd8;--ok:#16a34a;--shadow:0 6px 24px rgba(24,39,75,.06)}',
'.dark{--bg:#0f1218;--card:#171b24;--text:#e8ecf4;--muted:#8b94a8;--line:#262c3a;--accent:#3b82f6;--accent-h:#60a5fa;--ok:#22c55e;--shadow:0 6px 24px rgba(0,0,0,.35)}',
'*{box-sizing:border-box;margin:0;padding:0}',
'body{font-family:-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.6;-webkit-font-smoothing:antialiased}',
'.wrap{max-width:720px;margin:0 auto;padding:32px 18px 60px}',
'header{display:flex;justify-content:space-between;align-items:center;margin-bottom:26px}',
'.brand{font-size:19px;font-weight:700;letter-spacing:.2px}.brand small{display:block;font-size:12px;font-weight:400;color:var(--muted)}',
'#themeBtn{border:1px solid var(--line);background:var(--card);color:var(--text);width:38px;height:38px;border-radius:10px;cursor:pointer;font-size:16px}',
'.card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:22px}',
'textarea,select,input[type=text]{width:100%;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:15px;font-family:inherit;outline:none;transition:border-color .15s}',
'textarea:focus,select:focus,input[type=text]:focus{border-color:var(--accent)}',
'textarea{resize:vertical;min-height:130px}',
'.lbl{font-size:13px;font-weight:600;color:var(--muted);margin:14px 0 6px}',
'.lbl:first-child{margin-top:0}',
'.cnt{float:right;font-weight:400;font-size:12px}',
'.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
'@media(max-width:560px){.grid{grid-template-columns:1fr}}',
'details{border:1px solid var(--line);border-radius:10px;margin-top:14px;overflow:hidden}',
'details summary{cursor:pointer;padding:10px 14px;font-size:14px;font-weight:600;color:var(--muted);user-select:none;list-style:none}',
'details summary::before{content:"\\25B8 ";display:inline-block;transition:transform .15s}',
'details[open] summary::before{transform:rotate(90deg)}',
'details .inner{padding:4px 14px 14px}',
'.fmtrow{display:flex;gap:18px;align-items:center;margin-top:14px;flex-wrap:wrap}',
'.fmtrow label{font-size:14px;display:flex;gap:6px;align-items:center;cursor:pointer}',
'.switch{display:flex;gap:6px;align-items:center;font-size:14px;cursor:pointer;margin-left:auto}',
'.btn{width:100%;margin-top:16px;padding:12px;border:none;border-radius:11px;background:var(--accent);color:#fff;font-size:15.5px;font-weight:700;cursor:pointer;transition:background .15s;font-family:inherit}',
'.btn:hover{background:var(--accent-h)}',
'.btn[disabled]{opacity:.55;cursor:not-allowed}',
'.status{display:none;margin-top:12px;padding:9px 13px;border-radius:10px;font-size:13.5px}',
'.status.busy{display:block;background:rgba(37,99,235,.09);color:var(--accent)}',
'.status.err{display:block;background:rgba(220,38,38,.09);color:#dc2626}',
'.status.ok{display:block;background:rgba(22,163,74,.09);color:var(--ok)}',
'.result{display:none;margin-top:18px}',
'.result audio{width:100%;margin:10px 0}',
'.dl{display:flex;gap:10px;flex-wrap:wrap}',
'.dl a{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;border:1px solid var(--line);color:var(--text)}',
'.dl a.primary{background:var(--ok);border-color:var(--ok);color:#fff}',
'.meta{font-size:12.5px;color:var(--muted);margin-bottom:4px}',
'footer{text-align:center;margin-top:36px;font-size:12.5px;color:var(--muted)}',
'code{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:12.5px}',
'.apibox{margin-top:14px;font-size:13px;color:var(--muted)}',
'#console{font-family:Consolas,Monaco,monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-all;color:var(--muted);max-height:220px;overflow-y:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px}',
'</style>',
'</head>',
'<body>',
'<div class="wrap">',
'  <header>',
'    <div class="brand">MOML Voice <small>Edge TTS · 部署于 Cloudflare Workers</small></div>',
'    <button id="themeBtn" title="切换主题">◐</button>',
'  </header>',
'  <div class="card">',
'    <div class="lbl">输入文本 <span class="cnt" id="cnt">0 字</span></div>',
'    <textarea id="text" placeholder="请输入要合成的文字…"></textarea>',
'    <div class="grid">',
'      <div><div class="lbl">语音</div><select id="voice"></select></div>',
'      <div><div class="lbl">文件名</div><input type="text" id="fileName" placeholder="output"></div>',
'    </div>',
'    <details>',
'      <summary>高级参数</summary>',
'      <div class="inner">',
'        <div class="grid">',
'          <div><div class="lbl">语速</div><input type="text" id="rate" placeholder="+0%  例如 +20%"></div>',
'          <div><div class="lbl">音调</div><input type="text" id="pitch" placeholder="+0Hz  例如 -5Hz"></div>',
'          <div><div class="lbl">音量</div><input type="text" id="volume" placeholder="+0%  例如 +30%"></div>',
'        </div>',
'      </div>',
'    </details>',
'    <div class="fmtrow">',
'      <label><input type="radio" name="fmt" value="mp3" checked> MP3</label>',
'      <label><input type="radio" name="fmt" value="wav"> WAV</label>',
'      <label class="switch"><input type="checkbox" id="subtitles"> 生成字幕 (SRT)</label>',
'    </div>',
'    <button class="btn" id="go" onclick="generate()">生成语音</button>',
'    <div class="status" id="status"></div>',
'    <details id="logBox" style="margin-top:12px">',
'      <summary>运行日志</summary>',
'      <div class="inner" style="padding-top:10px"><pre id="console">[系统] 就绪</pre></div>',
'    </details>',
'    <div class="result" id="result">',
'      <div class="meta" id="meta"></div>',
'      <audio controls id="player"></audio>',
'      <div class="dl">',
'        <a id="dlAudio" class="primary" download="output.mp3">⤓ 下载音频</a>',
'        <a id="dlSrt" download="output.srt" style="display:none">⤓ 下载字幕</a>',
'      </div>',
'    </div>',
'    <div class="apibox">API：<code>POST /api/tts</code> JSON {"text":"你好","voice":"xiaoxiao"} · <code>GET /api/tts?text=你好</code> 直接下载音频</div>',
'  </div>',
'  <footer>Powered by Microsoft Edge TTS · Cloudflare Workers</footer>',
'</div>',
'<script>',
'var VOICES = ' + voicesJson + ';',
'var lastBlob = null, lastSrt = null;',
'(function(){',
'  var sel = document.getElementById("voice");',
'  var groups = {};',
'  VOICES.forEach(function(v){ (groups[v.group] = groups[v.group] || []).push(v); });',
'  Object.keys(groups).forEach(function(g){',
'    var og = document.createElement("optgroup"); og.label = g;',
'    groups[g].forEach(function(v){',
'      var o = document.createElement("option"); o.value = v.id; o.textContent = v.label; og.appendChild(o);',
'    });',
'    sel.appendChild(og);',
'  });',
'})();',
'var saved = localStorage.getItem("tts-theme");',
'if (saved === "dark" || (!saved && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)) document.body.classList.add("dark");',
'document.getElementById("themeBtn").onclick = function(){',
'  document.body.classList.toggle("dark");',
'  localStorage.setItem("tts-theme", document.body.classList.contains("dark") ? "dark" : "light");',
'};',
'document.getElementById("text").addEventListener("input", function(){',
'  document.getElementById("cnt").textContent = this.value.length + " 字";',
'});',
'function setStatus(cls, msg){',
'  var el = document.getElementById("status");',
'  el.className = "status " + cls; el.textContent = msg;',
'}',
'function log(msg){',
'  var el = document.getElementById("console");',
'  var t = new Date().toTimeString().slice(0, 8);',
'  el.textContent += "[" + t + "] " + msg + "\\n";',
'  el.scrollTop = el.scrollHeight;',
'}',
'function openLog(){ document.getElementById("logBox").open = true; }',
'function applyServerLog(str){',
'  if (!str) return;',
'  var s = str;',
'  try { s = decodeURI(str); } catch (_) {}',
'  s.split(" | ").forEach(function(s2){ log(s2); });',
'}',
'function fmtSize(n){ return n > 1048576 ? (n/1048576).toFixed(2) + " MB" : (n/1024).toFixed(1) + " KB"; }',
'function b64ToBlob(b64, mime){',
'  var bin = atob(b64), len = bin.length, buf = new Uint8Array(len);',
'  for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);',
'  return new Blob([buf], { type: mime });',
'}',
'function mp3ToWav(blob){',
'  var Ctx = window.AudioContext || window.webkitAudioContext;',
'  return blob.arrayBuffer().then(function(ab){ return new Ctx().decodeAudioData(ab); }).then(function(audioBuf){',
'    var ch = audioBuf.numberOfChannels, data = audioBuf.getChannelData(0), len = data.length;',
'    var buf = new ArrayBuffer(44 + len * 2), dv = new DataView(buf);',
'    function wstr(pos, s){ for (var i = 0; i < s.length; i++) dv.setUint8(pos + i, s.charCodeAt(i)); }',
'    wstr(0, "RIFF"); dv.setUint32(4, 36 + len * 2, true); wstr(8, "WAVE");',
'    wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);',
'    dv.setUint32(24, audioBuf.sampleRate, true); dv.setUint32(28, audioBuf.sampleRate * ch * 2, true);',
'    dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);',
'    wstr(36, "data"); dv.setUint32(40, len * 2, true);',
'    for (var i = 0; i < len; i++){',
'      var s = Math.max(-1, Math.min(1, data[i]));',
'      dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);',
'    }',
'    return new Blob([buf], { type: "audio/wav" });',
'  });',
'}',
'function showResult(blob, ext, fileName){',
'  lastBlob = blob;',
'  log("完成: " + ext.toUpperCase() + " " + fmtSize(blob.size) + "，已就绪");',
'  var url = URL.createObjectURL(blob);',
'  var player = document.getElementById("player");',
'  player.src = url;',
'  var dlA = document.getElementById("dlAudio");',
'  dlA.href = url; dlA.download = fileName + "." + ext; dlA.textContent = "⤓ 下载音频 (" + fmtSize(blob.size) + ")";',
'  var dlS = document.getElementById("dlSrt");',
'  if (lastSrt) {',
'    var surl = URL.createObjectURL(new Blob([lastSrt], { type: "text/plain" }));',
'    dlS.href = surl; dlS.download = fileName + ".srt"; dlS.style.display = "";',
'  } else { dlS.style.display = "none"; }',
'  document.getElementById("meta").textContent = "语音：" + document.getElementById("voice").selectedOptions[0].textContent;',
'  document.getElementById("result").style.display = "block";',
'  setStatus("ok", "合成完成");',
'  document.getElementById("go").disabled = false;',
'  player.play().catch(function(){});',
'}',
'function generate(){',
'  var text = document.getElementById("text").value;',
'  if (!text.trim()) { setStatus("err", "请输入要转换的文字"); return; }',
'  var fmt = document.querySelector("input[name=fmt]:checked").value;',
'  var wantSrt = document.getElementById("subtitles").checked;',
'  var btn = document.getElementById("go");',
'  btn.disabled = true;',
'  document.getElementById("result").style.display = "none";',
'  log("提交请求: " + text.length + " 字 / 语音 " + document.getElementById("voice").value + " / 格式 " + fmt + (wantSrt ? " / 生成字幕" : ""));',
'  setStatus("busy", "正在连接微软 TTS 服务并合成，长文本可能需要 10~30 秒，请稍候…");',
'  var payload = {',
'    text: text,',
'    voice: document.getElementById("voice").value,',
'    format: "mp3",',
'    rate: document.getElementById("rate").value || "+0%",',
'    pitch: document.getElementById("pitch").value || "+0Hz",',
'    volume: document.getElementById("volume").value || "+0%",',
'    subtitles: wantSrt ? "1" : "0",',
'    raw: wantSrt ? "0" : "1"',
'  };',
'  var fileName = (document.getElementById("fileName").value || "output").replace(/[\\\\/:*?"<>|]+/g, "_");',
'  var t0 = Date.now();',
'  fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })',
'  .then(function(r){',
'    var ct = r.headers.get("content-type") || "";',
'    log("服务端响应: HTTP " + r.status + " / " + ct.split(";")[0] + " / 耗时 " + (Date.now() - t0) + "ms");',
'    applyServerLog(r.headers.get("x-tts-log"));',
'    if (ct.indexOf("application/json") !== -1) return r.json().then(function(j){ return { json: j, ok: r.ok }; });',
'    return r.blob().then(function(b){ return { blob: b, ok: r.ok }; });',
'  })',
'  .then(function(res){',
'    if (!res.ok) { btn.disabled = false; openLog(); setStatus("err", (res.json && res.json.message) || "生成失败，请重试"); applyServerLog(res.json && res.json.console); log("生成失败"); return; }',
'    var mp3Blob;',
'    if (res.json) {',
'      if (res.json.result !== "success") { btn.disabled = false; openLog(); setStatus("err", res.json.message || "生成失败"); applyServerLog(res.json.console); return; }',
'      mp3Blob = b64ToBlob(res.json.audio_base64, "audio/mpeg");',
'      lastSrt = res.json.srt || null;',
'      applyServerLog(res.json.console);',
'    } else {',
'      mp3Blob = res.blob; lastSrt = null;',
'    }',
'    if (fmt === "wav") {',
'      log("开始本地解码 MP3 转 WAV…");',
'      setStatus("busy", "合成完成，正在本地解码为 WAV…");',
'      return mp3ToWav(mp3Blob).then(function(wavBlob){ log("WAV 解码完成: " + fmtSize(wavBlob.size)); showResult(wavBlob, "wav", fileName); },',
'        function(e){ btn.disabled = false; openLog(); log("本地 WAV 解码失败: " + (e && e.message ? e.message : e)); setStatus("err", "本地 WAV 解码失败：" + (e && e.message ? e.message : e)); });',
'    }',
'    showResult(mp3Blob, "mp3", fileName);',
'  })',
'  .catch(function(e){',
'    btn.disabled = false;',
'    openLog();',
'    log("网络错误: " + (e && e.message ? e.message : e));',
'    setStatus("err", "网络错误：" + (e && e.message ? e.message : e));',
'  });',
'}',
'</scr' + 'ipt>',
'</body>',
'</html>',
  ].join("\n");

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// Worker 入口
// ---------------------------------------------------------------------------

export default {
  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/":
      case "/index.html":
        return renderIndex();
      case "/api/tts":
        return handleTTS(request, url);
      case "/api/voices":
        return jsonResponse({ voices: VOICES });
      case "/favicon.ico":
        return new Response(null, { status: 204 });
      default:
        return jsonResponse({ result: "error", message: "Not Found" }, 404);
    }
  },
};
