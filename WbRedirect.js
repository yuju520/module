/**
 * Egern: 微博链接 → Lolipop / VVebo / 原版微博
 *
 * 写法对齐 TgRedirect.js（env_schema.CLIENT → ctx.env.CLIENT）。
 *
 * 与 Telegram 的差异（HAR 已证实）：
 * - 微信/Safari 打开 weibo.com|m.weibo.cn 后，H5 会注入
 *   appLink = sinaweibo://detail?mblogid=...
 *   以及 schemeOrigin = https://m.weibo.cn/feature/openapp?scheme=sinaweibo%3A%2F%2F...
 * - 微信内常走 wx-open-launch-app + Universal Link，body 里大量 sinaweibo://
 * - 因此必须「双通道」：
 *   http_request  → 内容页 302 到目标 scheme（对抗右上角「打开」/UL）
 *   http_response → Location/Refresh + body 里的官方 scheme 改写
 *
 * 「原版微博」：内容页不 302；若 body/头里已是第三方 scheme，改回 sinaweibo://
 */

const SCHEME = {
  Lolipop: "lolipop",
  VVebo: "vvebo",
  原版微博: "sinaweibo",
  // 容错别名
  lolipop: "lolipop",
  vvebo: "vvebo",
  sinaweibo: "sinaweibo",
  weibo: "sinaweibo",
  微博: "sinaweibo",
  原版: "sinaweibo",
  Weibo: "sinaweibo",
  官方微博: "sinaweibo",
};

// 长名在前，避免 sinaweibo 被 weibo 半截替换
const SOURCE_SCHEMES = [
  "weibointernational",
  "weibolite",
  "sinaweibo",
  "lolipop",
  "vvebo",
  "weibo",
];

function clientLabel(env) {
  return String((env && env.CLIENT) || "Lolipop").trim();
}

function targetScheme(env) {
  const raw = clientLabel(env);
  return SCHEME[raw] || SCHEME[raw.toLowerCase()] || "lolipop";
}

function isOfficial(label) {
  return (
    label === "原版微博" ||
    label === "Weibo" ||
    label === "官方微博" ||
    label === "原版" ||
    label === "微博"
  );
}

function qval(qs, key) {
  if (!qs) return "";
  const re = new RegExp(
    "(?:^|&)" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^&]*)",
  );
  const m = String(qs).match(re);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1].replace(/\+/g, " "));
  } catch (_) {
    return m[1];
  }
}

function headerGet(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return (
      headers.get(name) ||
      headers.get(name.toLowerCase()) ||
      headers.get(name.replace(/^\w/, (c) => c.toUpperCase())) ||
      ""
    );
  }
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k] || "";
  }
  return "";
}

function multiDecode(s, times) {
  let cur = s;
  for (let i = 0; i < (times || 3); i++) {
    try {
      const n = decodeURIComponent(cur);
      if (n === cur) break;
      cur = n;
    } catch (_) {
      break;
    }
  }
  return cur;
}

/**
 * 明文 / URL 编码 / JSON 转义 全覆盖
 * 用 (?<![a-zA-Z]) 防止 weibo 吃掉 sinaweibo 后缀（→ sinasinaweibo）
 */
function rewriteSchemes(text, target) {
  if (!text || typeof text !== "string") return text;
  if (!/sinaweibo|weibointernational|weibolite|lolipop|vvebo|weibo/i.test(text)) {
    return text;
  }

  let out = text;
  for (const src of SOURCE_SCHEMES) {
    if (src === target) continue;
    const esc = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 前缀不能是字母，避免 sina + weibo 误替换
    const b = "(?<![a-zA-Z])";

    out = out.replace(new RegExp(b + esc + "://", "gi"), target + "://");
    out = out.replace(
      new RegExp(b + esc + "%3A%2F%2F", "gi"),
      target + "%3A%2F%2F",
    );
    out = out.replace(
      new RegExp(b + esc + "%3a%2f%2f", "gi"),
      target + "%3a%2f%2f",
    );
    // JSON: scheme:\/\/
    out = out.replace(
      new RegExp(b + esc + ":\\\\/\\\\/", "gi"),
      target + ":\\/\\/",
    );
    // 双重转义 scheme:\\\/\\\/
    out = out.replace(
      new RegExp(b + esc + ":\\\\\\\\/\\\\\\\\/", "gi"),
      target + ":\\\\/\\\\/",
    );
  }
  return out;
}

/**
 * 把 sinaweibo://detail?... 等官方 deeplink 解析成语义，便于重建 vvebo path
 */
function parseAppScheme(schemeUrl) {
  if (!schemeUrl || typeof schemeUrl !== "string") return null;
  const m = schemeUrl.match(
    /^[a-z][a-z0-9+.-]*:\/\/([^?]*)(?:\?(.*))?$/i,
  );
  if (!m) return null;
  const path = (m[1] || "").replace(/\/+$/, "");
  const qs = m[2] || "";
  const head = path.split("/")[0].toLowerCase();

  if (head === "detail") {
    const id = qval(qs, "mblogid") || qval(qs, "id") || qval(qs, "mid");
    if (id) return { type: "status", id, url: schemeUrl };
  }
  if (head === "userinfo" || head === "userinfo?" || head === "user") {
    const uid = qval(qs, "uid") || qval(qs, "id");
    if (uid) return { type: "user", uid, url: schemeUrl };
    const name = qval(qs, "screen_name") || qval(qs, "name") || qval(qs, "nick");
    if (name) return { type: "user_name", name, url: schemeUrl };
  }
  if (head === "gotohome" || head === "home" || path === "") {
    return { type: "home", url: schemeUrl };
  }
  return null;
}

function isWeiboHost(host) {
  host = (host || "").toLowerCase();
  return (
    host === "weibo.com" ||
    host === "www.weibo.com" ||
    host === "m.weibo.com" ||
    host === "weibo.cn" ||
    host === "www.weibo.cn" ||
    host === "m.weibo.cn" ||
    host === "media.weibo.cn" ||
    host === "share.api.weibo.cn" ||
    host === "weibo.com.cn" ||
    host.endsWith(".weibo.com") ||
    host.endsWith(".weibo.cn") ||
    host.endsWith(".weibo.com.cn") ||
    host === "t.cn" ||
    host === "wb.cn" ||
    host.endsWith(".wb.cn")
  );
}

/**
 * 解析微博内容 URL → 语义
 * 覆盖 HAR 中：
 *   weibo.com/{uid}/{mid}
 *   m.weibo.cn/{uid}/{mid} → /status/{mid}
 *   m.weibo.cn/status/{mid}
 *   m.weibo.cn/feature/openapp?scheme=sinaweibo://detail?...
 */
function parseWeibo(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  const host = (u.hostname || "").toLowerCase();
  const path = u.pathname || "/";
  const qs = u.search ? u.search.slice(1) : "";
  const full = u.href;

  if (host === "t.cn" || host === "wb.cn") {
    return { type: "short", url: full };
  }
  if (!isWeiboHost(host)) return null;

  // 静态 / 埋点 / API：不当内容页 302
  if (
    /\.(js|css|png|jpe?g|gif|webp|ico|woff2?|map|mp4|m3u8|svg|json)(\?|$)/i.test(
      path,
    ) ||
    /\/(h5logs|actionLog|logservice|sdkconfig|client\/|aj\/|api\/|ajax\/|comments\/|sw\.js|manifest\.json)/i.test(
      path,
    )
  ) {
    return { type: "noise", url: full };
  }

  // HAR: /feature/openapp?scheme=sinaweibo%3A%2F%2Fdetail%3F...
  if (/\/feature\/openapp/i.test(path) || /\/openapp/i.test(path)) {
    const raw = qval(qs, "scheme") || qval(qs, "url") || qval(qs, "open_url");
    if (raw) {
      const decoded = multiDecode(raw, 4);
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(decoded)) {
        return { type: "scheme", scheme: decoded, url: full };
      }
    }
  }

  let m;
  m = path.match(/^\/(?:u|profile)\/(\d+)\/?$/i);
  if (m) return { type: "user", uid: m[1], url: full };

  m = path.match(/^\/n\/([^/?#]+)\/?$/i);
  if (m) {
    try {
      return { type: "user_name", name: decodeURIComponent(m[1]), url: full };
    } catch (_) {
      return { type: "user_name", name: m[1], url: full };
    }
  }

  // /status|detail|statuses/{id}  （HAR 主落地页）
  m = path.match(/^\/(?:status|detail|statuses)\/([A-Za-z0-9]+)\/?$/i);
  if (m) return { type: "status", id: m[1], url: full };

  // /{uid}/{bid|mid}
  m = path.match(/^\/(\d+)\/([A-Za-z0-9]+)\/?$/);
  if (m) return { type: "status", id: m[2], uid: m[1], url: full };

  const wid =
    qval(qs, "weibo_id") ||
    qval(qs, "mblogid") ||
    qval(qs, "mid") ||
    qval(qs, "id");
  if (wid && /share|status|detail|show/i.test(path + "?" + qs)) {
    return { type: "status", id: wid, url: full };
  }

  if (/^\/?(?:home|index)?$/i.test(path.replace(/\/$/, "") || "/")) {
    return { type: "home", url: full };
  }

  return { type: "link", url: full };
}

/**
 * 语义 → 目标 App deeplink
 * 官方/HAR 主路径：sinaweibo://detail?mblogid=
 * Lolipop 对齐同一 path（不兼容时至少能用根 scheme 唤起，见 buildFallback）
 * VVebo：user / status
 */
function buildTarget(scheme, info) {
  const enc = encodeURIComponent;

  if (info.type === "scheme" && info.scheme) {
    // 优先按官方 path 语义重建（vvebo 的 path 与 sinaweibo 不同）
    const semantic = parseAppScheme(info.scheme);
    if (semantic) return buildTarget(scheme, semantic);
    // 未知 path：仅替换 scheme 头
    return rewriteSchemes(info.scheme, scheme);
  }

  if (scheme === "vvebo") {
    if (info.type === "user" && info.uid) {
      return `vvebo://user?id=${enc(info.uid)}`;
    }
    if (info.type === "user_name" && info.name) {
      return `vvebo://user?name=${enc(info.name)}`;
    }
    if (info.type === "status" && info.id) {
      // 纯数字 mid 走 mid=；短码 mblogid 走 id=
      if (/^\d{10,}$/.test(info.id)) {
        return `vvebo://status?mid=${enc(info.id)}`;
      }
      return `vvebo://status?id=${enc(info.id)}`;
    }
    if (info.type === "home") return "vvebo://";
    return `vvebo://link?url=${enc(info.url)}`;
  }

  // lolipop / sinaweibo：对齐官方 detail / userinfo（HAR appLink）
  const s = scheme === "lolipop" ? "lolipop" : "sinaweibo";
  if (info.type === "user" && info.uid) {
    return `${s}://userinfo?uid=${enc(info.uid)}`;
  }
  if (info.type === "user_name" && info.name) {
    return `${s}://userinfo?screen_name=${enc(info.name)}`;
  }
  if (info.type === "status" && info.id) {
    // HAR: sinaweibo://detail?mblogid=5334008057563851&...
    return `${s}://detail?mblogid=${enc(info.id)}`;
  }
  if (info.type === "home") return `${s}://gotohome`;
  // 兜底：浏览器容器打开原链（官方支持；Lolipop 若不支持至少可改只 302 根路径）
  return `${s}://browser?url=${enc(info.url)}`;
}

function isContentNavigable(info) {
  if (!info) return false;
  if (info.type === "noise" || info.type === "link" || info.type === "short") {
    return false;
  }
  return (
    info.type === "status" ||
    info.type === "user" ||
    info.type === "user_name" ||
    info.type === "home" ||
    info.type === "scheme"
  );
}

function rewriteLocation(loc, target, official) {
  if (!loc) return loc;
  let next = rewriteSchemes(loc, target);
  if (official) return next;

  if (/^https?:\/\//i.test(next)) {
    const info = parseWeibo(next);
    if (info && isContentNavigable(info)) {
      return buildTarget(target, info);
    }
  }
  return next;
}

function respond302(loc) {
  return {
    status: 302,
    headers: {
      Location: loc,
      "Cache-Control": "no-store, no-cache",
    },
    body: "",
  };
}

export default async function (ctx) {
  const label = clientLabel(ctx.env || {});
  const target = targetScheme(ctx.env || {});
  const official = isOfficial(label);

  // ========== Response ==========
  if (ctx.response) {
    const result = {};
    let changed = false;

    try {
      const headers = ctx.response.headers;
      const loc =
        headerGet(headers, "Location") || headerGet(headers, "location");
      const refresh =
        headerGet(headers, "Refresh") || headerGet(headers, "refresh");
      const newHeaders = {};

      if (loc) {
        const nloc = rewriteLocation(loc, target, official);
        if (nloc && nloc !== loc) {
          newHeaders.Location = nloc;
          changed = true;
        }
      }
      if (refresh) {
        const nref = rewriteSchemes(refresh, target);
        if (nref !== refresh) {
          newHeaders.Refresh = nref;
          changed = true;
        }
      }
      if (Object.keys(newHeaders).length) result.headers = newHeaders;
    } catch (_) {}

    try {
      const text = await ctx.response.text();
      if (text != null && text !== "") {
        const next = rewriteSchemes(text, target);
        if (next !== text) {
          result.body = next;
          changed = true;
        }
      }
    } catch (_) {}

    if (changed) return result;
    return;
  }

  // ========== Request ==========
  const url = (ctx.request && ctx.request.url) || "";
  if (!url) return;

  // 1) URL 查询里嵌了 scheme=sinaweibo:// 或明文 scheme → 改 URL
  //    含 HAR 的 /feature/openapp?scheme=
  if (
    /[?&#](scheme|url|open_url|openurl|target|deeplink|deep_link)=/i.test(url) ||
    /sinaweibo:\/\/|weibo:\/\/|weibolite:\/\/|weibointernational:\/\//i.test(
      url,
    ) ||
    /sinaweibo%3A%2F%2F|weibo%3A%2F%2F/i.test(url)
  ) {
    // openapp：直接 302 到目标 deeplink（比改写请求 URL 更稳）
    const openInfo = parseWeibo(url);
    if (openInfo && openInfo.type === "scheme" && openInfo.scheme) {
      const loc = rewriteSchemes(openInfo.scheme, target);
      if (loc && !official) {
        return ctx.respond(respond302(loc));
      }
      if (loc && official && loc !== openInfo.scheme) {
        // 原版：确保是 sinaweibo
        return ctx.respond(respond302(rewriteSchemes(openInfo.scheme, "sinaweibo")));
      }
    }

    const next = rewriteSchemes(url, target);
    if (next !== url) return { url: next };
  }

  // 2) 原版：内容页不 302（对齐 Tg 选官方）
  if (official) return;

  // 3) 内容页 → 302 目标 App
  let info = parseWeibo(url);
  if (!info || info.type === "noise") return;

  if (info.type === "short") {
    try {
      const resp = await ctx.http.get(url, {
        redirect: "manual",
        timeout: 8000,
        credentials: "omit",
      });
      const loc =
        headerGet(resp.headers, "Location") ||
        headerGet(resp.headers, "location");
      if (loc && /^https?:/i.test(loc)) {
        info = parseWeibo(loc) || { type: "link", url: loc };
      } else if (loc && /:\/\//.test(loc)) {
        const nloc = rewriteSchemes(loc, target);
        return ctx.respond(respond302(nloc));
      } else {
        return;
      }
    } catch (_) {
      return;
    }
  }

  if (!isContentNavigable(info)) return;

  const loc = buildTarget(target, info);
  if (!loc) return;

  return ctx.respond(respond302(loc));
}
