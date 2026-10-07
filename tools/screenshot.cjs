/**
 * 项目截图脚本：驱动本地 Chromium 打开 worker 页面，
 * 生成真实运行截图（浅色界面 / 生成结果+日志 / 深色模式）。
 * 用法：先启动 wrangler dev --port 8787，再 NODE_PATH=<node_modules> node tools/screenshot.cjs
 */
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

// 自动探测本机 playwright 缓存的 Chromium；也可用环境变量 CHROME_PATH 指定
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  try {
    const dirs = fs.readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const sub of ["chrome-win64", "chrome-win"]) {
        const exe = path.join(root, d, sub, "chrome.exe");
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch (e) { /* ms-playwright 目录不存在 */ }
  throw new Error("未找到 Chromium：请安装 playwright 浏览器或设置 CHROME_PATH 指向 chrome.exe");
}

const CHROME = findChrome();
const BASE = "http://127.0.0.1:8787";
const OUT = path.resolve(__dirname, "../docs/images");
const DEMO_TEXT = "你好，欢迎体验部署在 Cloudflare Workers 上的 Edge TTS 文字转语音工具！不需要服务器，一个 JS 文件即可运行。";

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 860 },
    deviceScaleFactor: 2,
    locale: "zh-CN",
  });
  const page = await ctx.newPage();

  console.log("打开页面…");
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });

  // ---- 截图 1：浅色界面（已填入示例文本）----
  await page.fill("#text", DEMO_TEXT);
  await page.dispatchEvent("#text", "input");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "ui-light.png"), fullPage: true });
  console.log("✓ ui-light.png");

  // ---- 生成语音，等待结果 ----
  await page.click("#go");
  console.log("已点击生成，等待服务端合成…");
  await page.waitForSelector("#result", { state: "visible", timeout: 120000 });
  // 展开日志面板，等音频元素加载
  await page.evaluate(() => { document.getElementById("logBox").open = true; });
  await page.waitForTimeout(1500);
  await page.waitForFunction(
    () => { const a = document.getElementById("player"); return a && a.readyState >= 2; },
    { timeout: 30000 }
  ).catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "ui-result.png"), fullPage: true });
  console.log("✓ ui-result.png");

  // ---- 截图 3：深色模式 ----
  await page.click("#themeBtn");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "ui-dark.png"), fullPage: true });
  console.log("✓ ui-dark.png");

  await browser.close();
  console.log("截图完成");
})().catch((e) => { console.error("失败:", e.message); process.exit(1); });
