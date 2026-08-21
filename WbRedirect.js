/**
 * Egern: 微博网页链接 → 第三方 / 原版客户端重定向
 *
 * 说明：
 * - 客户端选择通过模块的 env_schema 写入模块级 env
 * - 脚本直接读取 ctx.env.CLIENT
 * - 选「原版微博」直接放行，不重定向
 *
 * 支持常见链接：
 * - https://weibo.com/u/{uid}
 * - https://weibo.com/{uid}/{mblogid}
 * - https://weibo.com/detail/{id} | /status/{id}
 * - https://m.weibo.cn/u/{uid} | /profile/{uid} | /detail/{id} | /status/{id}
 * - https://weibo.com/n/{screen_name}
 * - https://weibo.com/p/{containerid}
 * - https://s.weibo.com/weibo?q=...
 */

const SCHEME = {
  原版微博: "sinaweibo",
  Weibo: "sinaweibo",
  Lolipop: "lolipop",
  VVebo: "vvebo",
};

function qval(qs, key) {
  if (!qs) return "";
  const re = new RegExp(
    "(?:^|&)" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^&]*)",
  );
  const m = qs.match(re);
  return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
}

function stripQueryHash(path) {
  return path.split(/[?#]/)[0];
}

/** 是否像微博 mid / mblogid（数字 mid 或 base62 短码） */
function isMblogId(s) {
  return !!s && /^[0-9A-Za-z]+$/.test(s) && s.length >= 6 && s.length <= 20;
}

/** 纯数字 uid */
function isUid(s) {
  return !!s && /^\d{5,20}$/.test(s);
}

/**
 * 将 path + qs 转成客户端 deeplink
 * @param {string} s scheme，如 lolipop / vvebo / sinaweibo
 * @param {string} host
 * @param {string} path 不含开头 /
 * @param {string} qs querystring 不含 ?
 */
function deeplink(s, host, path, qs) {
  const p = stripQueryHash(path || "")
    .split("/")
    .filter(Boolean);

  // --- 搜索 ---
  // s.weibo.com/weibo?q=xxx  /  weibo.com/search?q=
  if (
    /^s\.weibo\.com$/i.test(host) ||
    p[0] === "search" ||
    p[0] === "searchall" ||
    (p[0] === "weibo" && /^s\.weibo\.com$/i.test(host))
  ) {
    const q = qval(qs, "q") || qval(qs, "keyword");
    if (q) return `${s}://searchall?q=${encodeURIComponent(q)}`;
  }

  // --- 博文详情 ---
  // /detail/{id}  /status/{id}
  if (
    (p[0] === "detail" || p[0] === "status" || p[0] === "show") &&
    p[1] &&
    isMblogId(p[1])
  ) {
    return `${s}://detail?mblogid=${encodeURIComponent(p[1])}`;
  }

  // m.weibo.cn/status/{id}?...
  if (p[0] === "status" && p[1] && isMblogId(p[1])) {
    return `${s}://detail?mblogid=${encodeURIComponent(p[1])}`;
  }

  // /{uid}/{mblogid}  如 weibo.com/1613133581/HlVM69RR9
  if (p.length >= 2 && isUid(p[0]) && isMblogId(p[1])) {
    return `${s}://detail?mblogid=${encodeURIComponent(p[1])}`;
  }

  // query 里带 id / mid / mblogid
  const qId = qval(qs, "mblogid") || qval(qs, "id") || qval(qs, "mid");
  if (qId && isMblogId(qId) && /detail|status|show|comment/i.test(path || "")) {
    return `${s}://detail?mblogid=${encodeURIComponent(qId)}`;
  }

  // --- 用户主页 ---
  // /u/{uid}
  if (p[0] === "u" && p[1] && isUid(p[1])) {
    return `${s}://userinfo?uid=${encodeURIComponent(p[1])}`;
  }
  // /profile/{uid}
  if (p[0] === "profile" && p[1] && isUid(p[1])) {
    return `${s}://userinfo?uid=${encodeURIComponent(p[1])}`;
  }
  // /n/{screen_name}
  if (p[0] === "n" && p[1]) {
    return `${s}://userinfo?screen_name=${encodeURIComponent(p[1])}`;
  }
  // 仅 /{uid}
  if (p.length === 1 && isUid(p[0])) {
    return `${s}://userinfo?uid=${encodeURIComponent(p[0])}`;
  }

  // --- 超话 / 页面容器 ---
  // /p/{containerid}
  if (p[0] === "p" && p[1]) {
    return `${s}://cardlist?containerid=${encodeURIComponent(p[1])}`;
  }

  // --- 文章 ---
  // /ttarticle/p/show?id=...
  if (p[0] === "ttarticle" || /article/i.test(path || "")) {
    const aid = qval(qs, "id") || (p[p.length - 1] && !p[p.length - 1].includes(".")
      ? p[p.length - 1]
      : "");
    if (aid) {
      // 官方常见：sinaweibo://article?id=
      return `${s}://article?id=${encodeURIComponent(aid)}`;
    }
  }

  // 无法识别具体页面时：打开客户端首页，避免无效 302
  if (s === "sinaweibo") return `${s}://gotohome`;
  return `${s}://`;
}

export default async function (ctx) {
  const url = ctx.request.url;
  const m = url.match(
    /^https?:\/\/((?:www\.)?weibo\.com|(?:www\.)?weibo\.cn|m\.weibo\.cn|s\.weibo\.com)\/?(.*)$/i,
  );
  if (!m) return;

const client = (ctx.env?.CLIENT || "原版微博").trim();

  // 选原版微博直接放行，不重定向（走网页 / Universal Link）
  if (client === "原版微博" || client === "Weibo") return;

  const scheme = SCHEME[client] || "lolipop";
  const host = m[1].toLowerCase();
  let tail = m[2] || "";

  const qi = tail.indexOf("?");
  const path = qi < 0 ? tail : tail.slice(0, qi);
  const qs = qi < 0 ? "" : tail.slice(qi + 1);

  // 静态资源 / API / 登录等不拦截
  const low = (path || "").toLowerCase();
  if (
    !path ||
    low.startsWith("ajax/") ||
    low.startsWith("api/") ||
    low.startsWith("passport") ||
    low.startsWith("login") ||
    low.startsWith("signup") ||
    low.startsWith("oauth") ||
    low.startsWith("aj/") ||
    low.includes(".") // css/js/png 等
  ) {
    return;
  }

  const loc = deeplink(scheme, host, path, qs);
  if (!loc) return;

  return ctx.respond({
    status: 302,
    headers: {
      Location: loc,
      "Cache-Control": "no-store, no-cache",
    },
    body: "",
  });
}
