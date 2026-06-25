import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_ROOT = path.resolve(__dirname, "public");
const CACHE_DIR = path.resolve(__dirname, "cache");

async function loadEnvLocal() {
  const envPath = path.join(__dirname, ".env.local");
  try {
    const text = await fs.readFile(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index === -1) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env.local is optional in hosted environments.
  }
}

await loadEnvLocal();
await fs.mkdir(CACHE_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "0.0.0.0";
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR || 30);
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 24);
const rateBuckets = new Map();

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function normalize(value) {
  return String(value || "").trim();
}

function cacheKey(input) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      name: normalize(input.name),
      city: normalize(input.city),
      district: normalize(input.district),
      category: normalize(input.category)
    }))
    .digest("hex");
}

async function readCache(key) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(file, "utf8"));
    const ageMs = Date.now() - new Date(cached.cachedAt).getTime();
    if (ageMs <= CACHE_TTL_HOURS * 60 * 60 * 1000) {
      return { ...cached.data, cacheHit: true, cachedAt: cached.cachedAt };
    }
  } catch {
    return null;
  }
  return null;
}

async function writeCache(key, data) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  await fs.writeFile(file, JSON.stringify({ cachedAt: new Date().toISOString(), data }, null, 2), "utf8");
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function checkRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (bucket.count > RATE_LIMIT_PER_HOUR) {
    return {
      ok: false,
      status: 429,
      body: {
        ok: false,
        code: "RATE_LIMITED",
        message: `调用太频繁。当前限制为每小时 ${RATE_LIMIT_PER_HOUR} 次，请稍后再试。`,
        resetAt: new Date(bucket.resetAt).toISOString()
      }
    };
  }
  return { ok: true, remaining: RATE_LIMIT_PER_HOUR - bucket.count, resetAt: bucket.resetAt };
}

function verifyAccess(req, body = {}) {
  if (!ACCESS_CODE) return { ok: true };
  const provided = normalize(req.headers["x-access-code"] || body.accessCode);
  if (provided === ACCESS_CODE) return { ok: true };
  return {
    ok: false,
    status: 401,
    body: {
      ok: false,
      code: "ACCESS_CODE_REQUIRED",
      message: "请输入正确访问码后再进行真实联网诊断。"
    }
  };
}

function inferCategory(name, snippets = "") {
  const text = `${name} ${snippets}`;
  if (/茶百道|喜茶|奈雪|霸王茶姬|蜜雪|古茗|沪上阿姨|一点点|茶颜悦色|书亦|益禾堂|CoCo|coco|奶茶|茶饮|新茶饮|果茶/.test(text)) return "奶茶/新茶饮";
  if (/火锅/.test(text)) return "火锅店";
  if (/川菜|餐厅|饭店|菜馆|烧烤|烤肉|料理|小吃|咖啡/.test(text)) return "餐饮";
  if (/口腔|牙科|正畸|种植牙|诊所/.test(text)) return "口腔诊所";
  if (/健身|瑜伽|普拉提|私教/.test(text)) return "健身房";
  if (/酒店|民宿|住宿/.test(text)) return "酒店住宿";
  return "本地商户";
}

function fallbackCompetitors(category, name) {
  const map = {
    "奶茶/新茶饮": ["喜茶", "奈雪的茶", "霸王茶姬", "蜜雪冰城", "古茗", "沪上阿姨", "书亦烧仙草"],
    "火锅店": ["海底捞", "呷哺呷哺", "凑凑火锅", "左庭右院", "小龙坎"],
    "口腔诊所": ["美奥口腔", "瑞尔齿科", "拜博口腔", "佳美口腔"],
    "健身房": ["乐刻运动", "超级猩猩", "威尔仕健身", "中田健身"],
    "酒店住宿": ["全季酒店", "亚朵酒店", "桔子酒店", "汉庭酒店"]
  };
  return (map[category] || ["同区高评分商户A", "同品类热门商户B", "商圈标杆商户C"])
    .filter(item => !name.includes(item) && !item.includes(name))
    .slice(0, 5);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

async function searchWeb(query) {
  if (process.env.SERPAPI_KEY) {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "baidu");
    url.searchParams.set("q", query);
    url.searchParams.set("api_key", process.env.SERPAPI_KEY);
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || `SerpApi HTTP ${response.status}`);
    }
    return (data.organic_results || data.results || []).slice(0, 8).map(item => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet || item.description || ""
    }));
  }

  if (process.env.BING_SEARCH_API_KEY) {
    const url = new URL("https://api.bing.microsoft.com/v7.0/search");
    url.searchParams.set("q", query);
    url.searchParams.set("mkt", "zh-CN");
    url.searchParams.set("count", "8");
    const response = await fetch(url, {
      headers: { "Ocp-Apim-Subscription-Key": process.env.BING_SEARCH_API_KEY }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `Bing HTTP ${response.status}`);
    return (data.webPages?.value || []).map(item => ({
      title: item.name,
      url: item.url,
      snippet: item.snippet || ""
    }));
  }

  throw new Error("未配置搜索 API。请配置 SERPAPI_KEY 或 BING_SEARCH_API_KEY。");
}

async function callDoubao(prompt) {
  const apiKey = process.env.ARK_API_KEY;
  const model = process.env.ARK_MODEL || process.env.DOUBAO_MODEL;
  if (!apiKey || !model) {
    throw new Error("未配置豆包 API。请配置 ARK_API_KEY 和 ARK_MODEL。");
  }
  const baseUrl = (process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "你是GEO商户诊断系统。只基于给定搜索资料和常识做审慎总结；不知道就说明证据不足。输出必须尽量结构化、可核验。"
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.2
    })
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`豆包接口失败 HTTP ${response.status}: ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw);
  return data.choices?.[0]?.message?.content || "";
}

function extractJson(text) {
  const fenced = String(text).match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : String(text).match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function liveDiagnose(input) {
  const name = normalize(input.name);
  const city = normalize(input.city);
  const district = normalize(input.district);
  const seedCategory = normalize(input.category);
  if (!name || !city || !district) throw new Error("商户名称、城市和区域不能为空。");

  const key = cacheKey({ name, city, district, category: seedCategory });
  if (!input.forceRefresh) {
    const cached = await readCache(key);
    if (cached) return cached;
  }

  const queries = [
    `${name} ${city} ${district} 评分 评论`,
    `${name} 品牌 行业 品类 核心卖点`,
    `${city} ${district} ${seedCategory || name} 竞品 推荐`,
    `${name} 用户评价 热门产品 门店`
  ];

  const searchGroups = await Promise.all(queries.map(q => searchWeb(q).catch(error => ([{
    title: "搜索失败",
    url: "",
    snippet: `${q}: ${error.message}`
  }]))));
  const searchResults = searchGroups.flat().filter(item => item.title !== "搜索失败").slice(0, 20);
  if (!searchResults.length) {
    return {
      ok: false,
      code: "NO_SEARCH_RESULTS",
      message: "未获得可用网络资料。请检查搜索 API Key、额度或换一个更明确的商户名称。",
      sourceCount: 0
    };
  }

  const snippets = searchResults
    .map((item, index) => `[${index + 1}] ${item.title}\n${item.snippet}\n${item.url}`)
    .join("\n\n");
  const category = seedCategory || inferCategory(name, snippets);
  const competitors = fallbackCompetitors(category, name);

  const prompt = `请基于以下网络搜索资料，为商户生成GEO诊断素材。

商户：${name}
城市：${city}
区域：${district}
初步行业：${category}
候选竞品：${competitors.join("、")}

网络资料：
${snippets}

要求：
1. 行业品类要精确，例如茶百道应为奶茶/新茶饮。
2. 核心卖点必须结合品牌和网络资料，不要套模板。
3. 竞品必须是同品类其他商户/品牌。
4. 场景关键词要对应真实消费场景。
5. 基础事实必须有资料依据；证据不足就写“证据不足”。
6. 豆包AI测试回答请模拟真实提问后的精简总结，不要夸大。
7. 评分控制在60分上下，除非证据非常强，不要给高分。

输出JSON，不要输出JSON之外的解释：
{
  "category": "",
  "rating": "",
  "reviewCount": "",
  "sellingPoints": [],
  "competitors": [],
  "scenarios": [],
  "facts": [],
  "sources": [],
  "aiAnswers": []
}`;

  const answer = await callDoubao(prompt);
  const parsed = extractJson(answer) || {};
  const cleanCompetitors = (parsed.competitors?.length ? parsed.competitors : competitors)
    .filter(item => item && !name.includes(item) && !String(item).includes(name))
    .slice(0, 6);

  const data = {
    ok: true,
    category: parsed.category || category,
    rating: parsed.rating || "",
    reviewCount: parsed.reviewCount || "",
    sellingPoints: (parsed.sellingPoints || []).slice(0, 8),
    competitors: cleanCompetitors,
    scenarios: (parsed.scenarios || []).slice(0, 8),
    facts: (parsed.facts || []).slice(0, 10),
    sources: (parsed.sources?.length ? parsed.sources : searchResults.map(item => `${item.title}｜${item.snippet}｜${item.url}`)).slice(0, 8),
    aiAnswers: (parsed.aiAnswers || []).slice(0, 6),
    sourceCount: searchResults.length,
    aiAnswerCount: (parsed.aiAnswers || []).length,
    cacheHit: false
  };
  await writeCache(key, data);
  return data;
}

async function serveStatic(res, reqPath) {
  const fileName = reqPath === "/" ? "index.html" : decodeURIComponent(reqPath.slice(1));
  const target = path.resolve(WEB_ROOT, fileName);
  if (!target.startsWith(WEB_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const body = await fs.readFile(target);
  const contentType = target.endsWith(".html")
    ? "text/html; charset=utf-8"
    : target.endsWith(".js")
      ? "application/javascript; charset=utf-8"
      : target.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "application/octet-stream";
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/live-diagnose") {
      const input = await readBody(req);
      const access = verifyAccess(req, input);
      if (!access.ok) return sendJson(res, access.status, access.body);

      const rate = checkRateLimit(req);
      if (!rate.ok) return sendJson(res, rate.status, rate.body);

      const data = await liveDiagnose(input);
      sendJson(res, data.ok ? 200 : 503, {
        ...data,
        rateLimitRemaining: rate.remaining,
        rateLimitResetAt: new Date(rate.resetAt).toISOString()
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, {
        ok: true,
        searchConfigured: Boolean(process.env.BING_SEARCH_API_KEY || process.env.SERPAPI_KEY),
        doubaoConfigured: Boolean(process.env.ARK_API_KEY && (process.env.ARK_MODEL || process.env.DOUBAO_MODEL)),
        accessCodeEnabled: Boolean(ACCESS_CODE),
        rateLimitPerHour: RATE_LIMIT_PER_HOUR,
        cacheTtlHours: CACHE_TTL_HOURS
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, service: "geo-lens-live" });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(res, url.pathname);
      return;
    }

    sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", message: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      code: "SERVER_ERROR",
      message: error.message || "服务器错误，请稍后重试。"
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`GEO Lens Live running at http://${HOST}:${PORT}`);
});
