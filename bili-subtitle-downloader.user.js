// ==UserScript==
// @name         B站字幕下载器
// @namespace    https://github.com/Tan-TanZi/bili-subtitle-downloader
// @version      1.0.4
// @description  分析当前B站视频的字幕（AI生成字幕 / 用户上传字幕），支持下载 TXT 纯文本与 SRT 字幕文件。点击右下角悬浮按钮展开面板，点「分析字幕」列出全部字幕后单击下载。
// @author       Tan-TanZi
// @homepageURL  https://github.com/Tan-TanZi/bili-subtitle-downloader
// @supportURL   https://github.com/Tan-TanZi/bili-subtitle-downloader/issues
// @updateURL    https://raw.githubusercontent.com/Tan-TanZi/bili-subtitle-downloader/main/bili-subtitle-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/Tan-TanZi/bili-subtitle-downloader/main/bili-subtitle-downloader.user.js
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      aisubtitle.hdslb.com
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // 页面真实 window：@grant 模式下脚本运行在隔离沙箱，
    // 必须通过 unsafeWindow 才能读写页面数据、hook 页面的 fetch/XHR
    const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

    // ==================== 常量 ====================
    /** 播放器信息接口（含字幕列表） */
    const PLAYER_API_RE = /\/x\/player\/(?:wbi\/)?v2\b/;
    /** 字幕文件地址（AI字幕 / 用户上传字幕），不锁死二级域名，B站换 CDN 也能抓到 */
    const SUB_FILE_RE = /\/\/[\w.-]*hdslb\.com\/bfs\/(?:ai_subtitle|subtitle)\//;
    const SUB_HOST = 'https://aisubtitle.hdslb.com';

    // 运行期状态
    const store = {
        key: '',        // 当前视频标识（bvid|p），用于判断抓到的数据是否属于当前视频
        cid: null,
        aid: null,
        bvid: null,
        list: [],       // 从播放器接口抓到的字幕列表
        subUrls: [],    // 抓到的字幕文件 URL（兜底）
    };

    // ==================== 通用工具 ====================

    /** 当前视频标识：视频页用 bvid + 分P，番剧页用路径 */
    function videoKey() {
        const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
        if (m) {
            const p = new URLSearchParams(location.search).get('p') || '1';
            return m[1] + '|' + p;
        }
        return location.pathname;
    }

    /** 解析 URL 查询参数（兼容相对地址） */
    function parseQuery(url) {
        try {
            return new URL(url, location.origin).searchParams;
        } catch (e) {
            return new URLSearchParams();
        }
    }

    /** 把字幕地址统一成完整 https 地址 */
    function normalizeUrl(u) {
        if (!u) return '';
        if (u.startsWith('//')) return 'https:' + u;
        if (/^https?:/i.test(u)) return u;
        if (u.startsWith('/')) return SUB_HOST + u;
        return SUB_HOST + '/' + u;
    }

    /** 文件名非法字符清理（Windows 下还不能以点或空格结尾）*/
    function sanitize(name) {
        const s = String(name || '')
            .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/[. ]+$/, '');
        return s || '字幕';
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    // ==================== 1. 网络抓取（页面世界 hook）====================

    /** 从播放器接口响应里取出字幕列表 */
    function extractFromPlayerJson(json) {
        try {
            const sub = json && json.data && json.data.subtitle;
            if (!sub || !Array.isArray(sub.subtitles)) return null;
            return sub.subtitles.filter(s => s && s.subtitle_url);
        } catch (e) {
            return null;
        }
    }

    /**
     * 字幕唯一键。
     * 不能只用 subtitle_url：AI 字幕每次返回的地址可能不同，
     * 那样反复抓取/反复分析就会把同一条字幕重复累加。
     */
    function subKey(s) {
        if (!s) return '';
        const kind = isAiSub(s) ? 'ai' : 'sub';
        const lan = String(s.lan || s.lan_doc || '').trim().toLowerCase();
        if (lan) return kind + '|' + lan;
        return kind + '|' + normalizeUrl(s.subtitle_url);
    }

    /** 合并去重（同一类型 + 同一语言只保留一条）*/
    function mergeSubs(a, b) {
        const map = new Map();
        (a || []).concat(b || []).forEach(s => {
            if (!s || !s.subtitle_url) return;
            const k = subKey(s);
            if (!map.has(k)) map.set(k, s);
        });
        return Array.from(map.values());
    }

    /** 当前页面 URL 里的 bvid（番剧页可能没有） */
    function currentBvid() {
        const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
        return m ? m[1] : '';
    }

    /** 抓到播放器接口数据 */
    function rememberPlayerJson(url, json) {
        const subs = extractFromPlayerJson(json);
        if (!subs || !subs.length) return;

        const q = parseQuery(url);
        const reqBvid = q.get('bvid');

        // 页面预加载/推荐位可能请求别的视频，与当前视频不符的数据直接丢弃
        const curBvid = currentBvid();
        if (curBvid && reqBvid && curBvid !== reqBvid) return;

        const cid = q.get('cid') || store.cid;
        const key = videoKey();

        // 换视频 / 换分P：丢弃旧数据
        if (store.key && (store.key !== key || (cid && store.cid && String(cid) !== String(store.cid)))) {
            store.list = [];
            store.subUrls = [];
        }
        store.key = key;
        store.cid = cid || store.cid;
        store.aid = q.get('aid') || store.aid;
        store.bvid = reqBvid || store.bvid;
        store.list = mergeSubs(store.list, subs);
        updateStatusByCapture();
    }

    /** 抓到字幕文件地址（仅作兜底，限制条数防止无限累积）*/
    function rememberSubUrl(url) {
        const full = normalizeUrl(url);
        if (store.subUrls.includes(full)) return;
        if (store.subUrls.length >= 20) store.subUrls.shift();
        store.subUrls.push(full);
        updateStatusByCapture();
    }

    /** hook 页面 fetch */
    (function hookFetch() {
        const orig = pageWindow.fetch;
        if (typeof orig !== 'function') return;
        pageWindow.fetch = function (input) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const promise = orig.apply(this, arguments);
            try {
                if (PLAYER_API_RE.test(url)) {
                    promise.then(res => res.clone().json()
                        .then(json => rememberPlayerJson(url, json))
                        .catch(() => {})).catch(() => {});
                } else if (SUB_FILE_RE.test(url)) {
                    rememberSubUrl(url);
                }
            } catch (e) { /* 忽略 hook 自身异常 */ }
            return promise;
        };
    })();

    /** hook 页面 XMLHttpRequest */
    (function hookXHR() {
        const XHR = pageWindow.XMLHttpRequest;
        if (!XHR) return;
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;

        XHR.prototype.open = function (method, url) {
            this.__bsubUrl = url;
            return origOpen.apply(this, arguments);
        };
        XHR.prototype.send = function () {
            const url = this.__bsubUrl || '';
            if (PLAYER_API_RE.test(url) || SUB_FILE_RE.test(url)) {
                this.addEventListener('load', () => {
                    try {
                        const type = this.responseType;
                        if (type && type !== 'text' && type !== 'json') return;
                        if (SUB_FILE_RE.test(url)) {
                            rememberSubUrl(url);
                            return;
                        }
                        if (type === 'json') {
                            rememberPlayerJson(url, this.response);
                        } else if (this.responseText) {
                            rememberPlayerJson(url, JSON.parse(this.responseText));
                        }
                    } catch (e) { /* 忽略解析异常 */ }
                });
            }
            return origSend.apply(this, arguments);
        };
    })();

    // ==================== 2. 视频信息 ====================

    /** 读取当前视频的 bvid / aid / cid / 标题 / 分P */
    function getVideoInfo() {
        const info = { bvid: '', aid: null, cid: null, title: '', p: 1, totalP: 1 };

        const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
        if (m) info.bvid = m[1];

        const pStr = new URLSearchParams(location.search).get('p');
        if (pStr) info.p = parseInt(pStr, 10) || 1;

        const st = pageWindow.__INITIAL_STATE__;
        if (st) {
            // 普通投稿
            const vd = st.videoData;
            if (vd) {
                if (vd.aid) info.aid = vd.aid;
                if (vd.bvid) info.bvid = vd.bvid;
                info.title = vd.title || info.title;
                if (Array.isArray(vd.pages) && vd.pages.length) {
                    info.totalP = vd.pages.length;
                    const page = vd.pages[info.p - 1] || vd.pages[0];
                    info.cid = page && page.cid;
                } else if (vd.cid) {
                    info.cid = vd.cid;
                }
            }
            // 番剧 / 影视
            const ep = st.epInfo;
            if (ep) {
                if (ep.aid) info.aid = ep.aid;
                if (ep.cid) info.cid = ep.cid;
                if (ep.bvid) info.bvid = ep.bvid;
                const media = st.mediaInfo && st.mediaInfo.title;
                info.title = [media, ep.title].filter(Boolean).join(' ') || info.title;
            }
        }

        // 兜底：本次会话内抓到的（仅当属于当前视频时可信）
        if (store.key === videoKey()) {
            if (info.cid == null) info.cid = store.cid;
            if (info.aid == null) info.aid = store.aid;
            if (!info.bvid) info.bvid = store.bvid;
        }

        if (!info.title) {
            info.title = document.title.replace(/[_-]哔哩哔哩.*$/, '').trim();
        }
        return info;
    }

    /** 主动请求播放器接口拿字幕列表 */
    async function queryPlayerApi(info) {
        if (!info.cid) return [];
        const params = new URLSearchParams();
        if (info.aid) params.set('aid', info.aid);
        if (info.bvid) params.set('bvid', info.bvid);
        params.set('cid', info.cid);

        const urls = [
            `https://api.bilibili.com/x/player/wbi/v2?${params}`,
            `https://api.bilibili.com/x/player/v2?${params}`,
        ];
        for (const u of urls) {
            try {
                const res = await fetch(u, { credentials: 'include' });
                const json = await res.json();
                const subs = extractFromPlayerJson(json);
                if (json && json.code === 0 && subs) return subs;
            } catch (e) { /* 换下一个接口 */ }
            // fetch 失败时用 GM 请求兜底
            try {
                const text = await gmGet(u);
                const json = JSON.parse(text);
                const subs = extractFromPlayerJson(json);
                if (json && json.code === 0 && subs) return subs;
            } catch (e) { /* 继续 */ }
        }
        return [];
    }

    /** GM_xmlhttpRequest 兜底请求（绕过 CORS）*/
    function gmGet(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('无 GM_xmlhttpRequest'));
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 20000,
                onload: r => (r.status >= 200 && r.status < 400)
                    ? resolve(r.responseText)
                    : reject(new Error('HTTP ' + r.status)),
                onerror: () => reject(new Error('网络错误')),
                ontimeout: () => reject(new Error('请求超时')),
            });
        });
    }

    // ==================== 3. 字幕内容解析 / 格式转换 ====================

    /** 获取字幕 JSON（优先页面 fetch，失败走 GM）*/
    async function fetchSubtitleJson(rawUrl) {
        const url = normalizeUrl(rawUrl);
        try {
            const res = await fetch(url, { credentials: 'omit' });
            if (res.ok) return await res.json();
        } catch (e) { /* 走兜底 */ }
        const text = await gmGet(url);
        return JSON.parse(text);
    }

    /** 兼容多种结构的 body 提取 */
    function pickBody(json) {
        if (!json) return null;
        if (Array.isArray(json.body)) return json.body;
        if (json.data && Array.isArray(json.data.body)) return json.data.body;
        return null;
    }

    /** 秒 → SRT 时间戳 00:00:05,120 */
    function fmtTime(sec) {
        let ms = Math.round(Number(sec) * 1000);
        if (!isFinite(ms) || ms < 0) ms = 0;
        const pad = (n, l) => String(n).padStart(l || 2, '0');
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        const mis = ms % 1000;
        return `${pad(h)}:${pad(m)}:${pad(s)},${pad(mis, 3)}`;
    }

    /** 生成 SRT 文本 */
    function toSRT(body) {
        const out = [];
        body.forEach((it, i) => {
            out.push(String(i + 1));
            out.push(`${fmtTime(it.from)} --> ${fmtTime(it.to)}`);
            out.push(String(it.content || '').trim());
            out.push('');
        });
        return out.join('\n');
    }

    /** 生成 TXT 纯文本（一行一条）*/
    function toTXT(body) {
        return body
            .map(it => String(it.content || '').trim())
            .filter(Boolean)
            .join('\n');
    }

    /** 触发浏览器下载 */
    function download(filename, text, withBOM) {
        const content = (withBOM ? '\ufeff' : '') + text;
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(a.href);
            a.remove();
        }, 1500);
    }

    /** 组装文件名 */
    function buildBaseName(info, item) {
        const title = sanitize(info.title || 'B站视频').slice(0, 60);
        const p = info.p > 1 ? `_P${info.p}` : '';
        const lan = sanitize(item.lan_doc || item.lan || '字幕');
        return `${title}${p}_${lan}`;
    }

    /** 是否 AI 字幕 */
    function isAiSub(item) {
        return /\/ai_subtitle\//.test(item.subtitle_url || '') || /^ai-/i.test(item.lan || '');
    }

    // ==================== 4. 面板 UI ====================

    const panelHTML = `
<div id="bsub-btn" title="B站字幕下载（点击展开，可拖动）">
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
    <path d="M12 2a1 1 0 0 1 1 1v9.586l3.293-3.293a1 1 0 1 1 1.414 1.414l-5 5a1 1 0 0 1-1.414 0l-5-5a1 1 0 1 1 1.414-1.414L11 12.586V3a1 1 0 0 1 1-1z"/>
    <path d="M5 20h14v2H5z"/>
  </svg>
</div>
<div id="bsub-panel" style="display:none;">
  <div id="bsub-header">
    <span id="bsub-header-title">B站字幕下载</span>
    <button id="bsub-close" title="关闭">✕</button>
  </div>
  <div id="bsub-body">
    <div id="bsub-vinfo" class="bsub-vinfo">--</div>
    <div class="bsub-actions">
      <button id="bsub-analyze" class="bsub-btn bsub-btn-primary">🔍 分析字幕</button>
      <button id="bsub-clear" class="bsub-btn">清空</button>
    </div>
    <div class="bsub-sources">
      <span class="bsub-sources-label">字幕来源：</span>
      <label class="bsub-check" title="从播放器已发出的请求里读取字幕"><input type="checkbox" id="bsub-src-hook" checked>网络抓取</label>
      <label class="bsub-check" title="脚本主动调用B站播放器接口"><input type="checkbox" id="bsub-src-api">主动请求</label>
    </div>
    <div id="bsub-src-desc" class="bsub-src-desc"></div>
    <div id="bsub-status" class="bsub-status">点击「分析字幕」，获取当前视频的字幕列表</div>
    <div id="bsub-list" class="bsub-list"></div>
    <div class="bsub-tip">💡 TXT = 纯字幕文本；SRT = 带时间轴的字幕文件</div>
    <div class="bsub-tip">💡 两路都勾选时结果取并集（最全）；只勾一路则只用那一路</div>
  </div>
</div>`;

    const panelCSS = `
#bsub-btn {
  position: fixed; bottom: 120px; right: 16px; z-index: 999998;
  width: 42px; height: 42px; border-radius: 50%;
  background: #00a1d6; color: #fff; border: none; cursor: grab;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 12px rgba(0,0,0,0.25);
  transition: transform .2s, box-shadow .2s, opacity .3s;
  opacity: .75; user-select: none;
}
#bsub-btn:active { cursor: grabbing; }
#bsub-btn:hover { transform: scale(1.1); box-shadow: 0 4px 20px rgba(0,161,214,.5); opacity: 1; }

#bsub-panel {
  position: fixed; bottom: 170px; right: 16px; z-index: 999999;
  width: 330px; background: #fff; border-radius: 12px;
  box-shadow: 0 8px 40px rgba(0,0,0,.22);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #333; overflow: hidden;
}
#bsub-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 11px 14px; cursor: move; user-select: none;
  background: linear-gradient(135deg, #00a1d6, #00b5e5); color: #fff;
}
#bsub-header-title { font-size: 14px; font-weight: 600; }
#bsub-close {
  background: none; border: none; color: #fff; font-size: 15px;
  cursor: pointer; padding: 0 4px; line-height: 1; opacity: .85;
}
#bsub-close:hover { opacity: 1; }
#bsub-body {
  padding: 12px 14px 14px; overflow-y: auto;
  max-height: min(460px, calc(100vh - 150px));   /* 小屏时自动收窄，保证不超出窗口 */
}

.bsub-vinfo {
  font-size: 12px; color: #666; background: #f6f9fb; border-radius: 6px;
  padding: 7px 9px; line-height: 1.5; word-break: break-all; margin-bottom: 10px;
}
.bsub-vinfo b { color: #00a1d6; }
.bsub-actions { display: flex; gap: 8px; margin-bottom: 8px; }

/* 字幕来源开关 */
.bsub-sources {
  display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
  font-size: 12px; color: #555; margin-bottom: 5px;
}
.bsub-sources-label { color: #999; }
.bsub-check {
  display: inline-flex; align-items: center; gap: 4px;
  cursor: pointer; user-select: none;
}
.bsub-check input { margin: 0; cursor: pointer; }
.bsub-src-desc {
  font-size: 11px; color: #999; line-height: 1.5;
  margin-bottom: 8px; padding: 5px 8px; border-radius: 6px; background: #f7f9fa;
}
.bsub-src-desc.is-both { color: #27ae60; background: #f1faf3; }
.bsub-src-desc.is-warn { color: #d35400; background: #fff7ef; }

.bsub-btn {
  font-size: 13px; padding: 6px 14px; border: 1px solid #e0e0e0;
  border-radius: 6px; background: #fff; cursor: pointer; color: #333;
  transition: background .15s, border-color .15s;
}
.bsub-btn:hover { background: #f5f5f5; border-color: #ccc; }
.bsub-btn:disabled { opacity: .55; cursor: not-allowed; }
.bsub-btn-primary { background: #00a1d6; color: #fff; border-color: #00a1d6; }
.bsub-btn-primary:hover { background: #008fbf; border-color: #008fbf; }

.bsub-status { font-size: 12px; color: #888; padding: 3px 0 8px; line-height: 1.5; }
.bsub-status.is-ok { color: #27ae60; }
.bsub-status.is-err { color: #e74c3c; }

.bsub-list { display: flex; flex-direction: column; gap: 6px; }
.bsub-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  border: 1px solid #eee; border-radius: 8px; padding: 8px 10px;
  transition: border-color .15s, background .15s;
}
.bsub-item:hover { border-color: #b9e3f2; background: #f8fdff; }
.bsub-item-main { min-width: 0; display: flex; align-items: center; gap: 6px; }
.bsub-item-name {
  font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 150px;
}
.bsub-tag {
  font-size: 10px; padding: 1px 5px; border-radius: 4px; flex-shrink: 0;
  border: 1px solid transparent;
}
.bsub-tag-ai { color: #8e44ad; background: #f6eeff; border-color: #e2ccf7; }
.bsub-tag-user { color: #00838f; background: #eafaff; border-color: #c4ecf7; }
.bsub-item-btns { display: flex; gap: 5px; flex-shrink: 0; }
.bsub-dl {
  font-size: 11px; padding: 3px 8px; border-radius: 5px; cursor: pointer;
  border: 1px solid #00a1d6; background: #fff; color: #00a1d6;
  transition: background .15s, color .15s;
}
.bsub-dl:hover { background: #00a1d6; color: #fff; }
.bsub-dl:disabled { opacity: .5; cursor: wait; }
.bsub-tip { font-size: 11px; color: #bbb; line-height: 1.45; padding-top: 6px; }
`;

    let btnEl = null;
    let panelEl = null;
    let listEl = null;
    let statusEl = null;

    function injectCSS() {
        if (document.getElementById('bsub-style')) return;
        const style = document.createElement('style');
        style.id = 'bsub-style';
        style.textContent = panelCSS;
        document.head.appendChild(style);
    }

    function initUI() {
        if (document.getElementById('bsub-root')) return;
        injectCSS();

        const root = document.createElement('div');
        root.id = 'bsub-root';
        root.innerHTML = panelHTML;
        document.body.appendChild(root);

        btnEl = document.getElementById('bsub-btn');
        panelEl = document.getElementById('bsub-panel');
        listEl = document.getElementById('bsub-list');
        statusEl = document.getElementById('bsub-status');

        document.getElementById('bsub-close').addEventListener('click', hidePanel);
        document.getElementById('bsub-analyze').addEventListener('click', analyze);
        document.getElementById('bsub-clear').addEventListener('click', () => {
            listEl.innerHTML = '';
            setStatus('已清空列表', '');
        });

        // 字幕来源开关：切换后清空旧结果，避免两路结果混淆
        ['bsub-src-hook', 'bsub-src-api'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => {
                updateSrcDesc();
                listEl.innerHTML = '';
                setStatus('已切换字幕来源，请重新点「分析字幕」', '');
            });
        });
        updateSrcDesc();

        bindDrag();
        bindHeaderDrag();
    }

    function setStatus(text, type) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = 'bsub-status' + (type ? ' is-' + type : '');
    }

    /** 抓取过程中同步提示 */
    function updateStatusByCapture() {
        if (!statusEl || !panelEl || panelEl.style.display === 'none') return;
        if (!useHook()) return;   // 没勾「网络抓取」就不提示
        if (store.list.length) {
            setStatus(`网络抓取到 ${store.list.length} 条字幕，可直接点「分析字幕」`, 'ok');
        }
    }

    function renderVideoInfo(info) {
        const el = document.getElementById('bsub-vinfo');
        if (!el) return;
        const pInfo = info.totalP > 1 ? ` ｜ P${info.p}/${info.totalP}` : '';
        el.innerHTML = '';
        const t = document.createElement('div');
        t.innerHTML = `<b>${escapeHtml(info.title || '未知标题')}</b>`;
        const d = document.createElement('div');
        d.textContent = `${info.bvid || '—'} ｜ cid: ${info.cid || '未获取'}${pInfo}`;
        el.appendChild(t);
        el.appendChild(d);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    /** 渲染字幕列表 */
    function renderList(list, info) {
        listEl.innerHTML = '';
        list.forEach(item => {
            const ai = isAiSub(item);

            const row = document.createElement('div');
            row.className = 'bsub-item';

            const main = document.createElement('div');
            main.className = 'bsub-item-main';

            const name = document.createElement('span');
            name.className = 'bsub-item-name';
            name.textContent = item.lan_doc || item.lan || '未命名字幕';
            name.title = normalizeUrl(item.subtitle_url);

            const tag = document.createElement('span');
            tag.className = 'bsub-tag ' + (ai ? 'bsub-tag-ai' : 'bsub-tag-user');
            tag.textContent = ai ? 'AI字幕' : '用户上传';

            main.appendChild(name);
            main.appendChild(tag);

            const btns = document.createElement('div');
            btns.className = 'bsub-item-btns';
            ['txt', 'srt'].forEach(fmt => {
                const b = document.createElement('button');
                b.className = 'bsub-dl';
                b.textContent = fmt.toUpperCase();
                b.title = `下载 ${fmt.toUpperCase()} 文件`;
                b.addEventListener('click', () => downloadSub(item, fmt, info, b));
                btns.appendChild(b);
            });

            row.appendChild(main);
            row.appendChild(btns);
            listEl.appendChild(row);
        });
    }

    // ==================== 5. 分析 & 下载 ====================

    /** 是否使用「网络抓取」 */
    function useHook() {
        const el = document.getElementById('bsub-src-hook');
        return !el || el.checked;   // 默认开启
    }

    /** 是否使用「主动请求」 */
    function useApi() {
        const el = document.getElementById('bsub-src-api');
        return !!el && el.checked;  // 默认关闭
    }

    /** 开关下方的说明文案：告诉用户两种来源的区别 */
    const SRC_DESC = {
        hook: '【网络抓取】从播放器已经发出的请求里读取字幕，不额外发请求、最稳定；但需要先在播放器里开启一次字幕，才会产生可抓取的请求。',
        api: '【主动请求】脚本主动调用B站播放器接口，不用手动开字幕；但未登录时拿不到 AI 字幕，频繁点击可能触发风控。',
        both: '✅ 两路并用：先按「主动请求」取接口列表，再用「网络抓取」补齐（如接口里没有的 AI 字幕），结果取并集，最全。',
        none: '⚠ 至少要勾选一种来源，否则无法分析。',
    };

    function updateSrcDesc() {
        const el = document.getElementById('bsub-src-desc');
        if (!el) return;
        const h = useHook();
        const a = useApi();
        if (h && a) {
            el.textContent = SRC_DESC.both;
            el.className = 'bsub-src-desc is-both';
        } else if (h) {
            el.textContent = SRC_DESC.hook;
            el.className = 'bsub-src-desc';
        } else if (a) {
            el.textContent = SRC_DESC.api;
            el.className = 'bsub-src-desc';
        } else {
            el.textContent = SRC_DESC.none;
            el.className = 'bsub-src-desc is-warn';
        }
    }

    /** 防连点：上一次分析没结束时不重复发起 */
    let analyzing = false;

    async function analyze() {
        if (analyzing) return;

        const btn = document.getElementById('bsub-analyze');
        const info = getVideoInfo();
        renderVideoInfo(info);

        const h = useHook();
        const a = useApi();
        if (!h && !a) {
            setStatus('请至少勾选一种字幕来源', 'err');
            return;
        }
        if (!info.cid) {
            setStatus('未能获取视频 cid，请刷新页面或先播放一下视频再试', 'err');
            return;
        }

        analyzing = true;
        btn.disabled = true;
        setStatus('正在分析字幕…', '');
        listEl.innerHTML = '';

        try {
            const sameVideo = store.key === videoKey();
            // 抓取到的数据只当作「快照」使用，不写回 store，避免反复分析时列表膨胀
            const hookList = (h && sameVideo) ? store.list.slice() : [];
            const hookUrls = (h && sameVideo) ? store.subUrls.slice() : [];
            let apiList = [];

            if (a) {
                try {
                    apiList = (await queryPlayerApi(info)) || [];
                } catch (e) { /* 接口异常则只用抓取结果 */ }
            }

            const sourceNote = (h && a) ? '（网络抓取 + 主动请求）' : (a ? '（主动请求）' : '（网络抓取）');
            let list = mergeSubs(apiList, hookList);
            let fallbackUsed = false;

            // 兜底：接口没返回列表、也没抓到接口列表，但抓到过字幕文件地址
            if (!list.length && hookUrls.length) {
                list = hookUrls.map(u => ({
                    subtitle_url: u,
                    lan: '',
                    lan_doc: /ai_subtitle/.test(u) ? 'AI字幕' : '字幕',
                }));
                fallbackUsed = true;
            }

            if (list.length) {
                store.key = videoKey();
                store.cid = store.cid || info.cid;
                renderList(list, info);
                setStatus(fallbackUsed
                    ? `接口未返回列表，已从网络请求里捕获 ${list.length} 条字幕${sourceNote}`
                    : `共发现 ${list.length} 条字幕${sourceNote}，点右侧 TXT / SRT 下载`, 'ok');
            } else if (h && !a) {
                setStatus('未捕获到字幕。请先播放视频并在播放器里开启一次字幕再分析，或勾选「主动请求」', 'err');
            } else if (a && !h) {
                setStatus('接口未返回字幕。可能是未登录（AI字幕需要登录），或该视频确实没有字幕', 'err');
            } else {
                setStatus('未发现字幕。可能未登录，或该视频确实没有字幕', 'err');
            }
        } finally {
            analyzing = false;
            btn.disabled = false;
        }
    }

    async function downloadSub(item, fmt, info, btn) {
        const old = btn.textContent;
        btn.disabled = true;
        btn.textContent = '…';
        setStatus(`正在获取字幕内容（${fmt.toUpperCase()}）…`, '');
        try {
            const json = await fetchSubtitleJson(item.subtitle_url);
            const body = pickBody(json);
            if (!Array.isArray(body) || !body.length) throw new Error('字幕内容为空');

            const base = buildBaseName(info, item);
            if (fmt === 'srt') {
                download(base + '.srt', toSRT(body), false);
            } else {
                download(base + '.txt', toTXT(body), true);
            }
            setStatus(`已下载 ${base}.${fmt}（共 ${body.length} 条）`, 'ok');
        } catch (e) {
            setStatus('下载失败：' + ((e && e.message) || e), 'err');
        } finally {
            btn.disabled = false;
            btn.textContent = old;
        }
    }

    // ==================== 6. 面板显隐 / 拖拽 ====================

    function showPanel() {
        panelEl.style.display = 'block';
        renderVideoInfo(getVideoInfo());
        positionPanel();
        if (!listEl.children.length && useHook() && store.key === videoKey() && store.list.length) {
            setStatus(`网络抓取到 ${store.list.length} 条字幕，点「分析字幕」查看`, 'ok');
        }
    }

    function hidePanel() {
        panelEl.style.display = 'none';
    }

    function togglePanel() {
        if (panelEl.style.display === 'none') showPanel();
        else hidePanel();
    }

    /** 面板贴着悬浮按钮显示，并保证不出屏 */
    function positionPanel() {
        const r = btnEl.getBoundingClientRect();
        const pw = panelEl.offsetWidth;
        const ph = panelEl.offsetHeight;
        let left = r.left - pw - 10;
        if (left < 8) left = Math.min(r.right + 10, window.innerWidth - pw - 8);
        let top = r.top;
        if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
        panelEl.style.left = Math.max(8, left) + 'px';
        panelEl.style.top = Math.max(8, top) + 'px';
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
    }

    /** 悬浮按钮：拖拽 + 点击 */
    function bindDrag() {
        let drag = null;

        btnEl.addEventListener('mousedown', e => {
            const rect = btnEl.getBoundingClientRect();
            drag = { sx: e.clientX, sy: e.clientY, left: rect.left, top: rect.top, moved: false };
            e.preventDefault();
        });

        document.addEventListener('mousemove', e => {
            if (!drag) return;
            const dx = e.clientX - drag.sx;
            const dy = e.clientY - drag.sy;
            if (!drag.moved && Math.hypot(dx, dy) < 4) return;
            drag.moved = true;
            const w = btnEl.offsetWidth;
            const h = btnEl.offsetHeight;
            btnEl.style.left = clamp(drag.left + dx, 0, window.innerWidth - w) + 'px';
            btnEl.style.top = clamp(drag.top + dy, 0, window.innerHeight - h) + 'px';
            btnEl.style.right = 'auto';
            btnEl.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (drag && !drag.moved) togglePanel();
            drag = null;
        });
    }

    /** 面板头部拖拽移动 */
    function bindHeaderDrag() {
        const header = document.getElementById('bsub-header');
        let drag = null;
        header.addEventListener('mousedown', e => {
            if (e.target.id === 'bsub-close') return;
            const rect = panelEl.getBoundingClientRect();
            drag = { sx: e.clientX, sy: e.clientY, left: rect.left, top: rect.top };
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!drag) return;
            const pw = panelEl.offsetWidth;
            const ph = panelEl.offsetHeight;
            panelEl.style.left = clamp(drag.left + e.clientX - drag.sx, 0, window.innerWidth - pw) + 'px';
            panelEl.style.top = clamp(drag.top + e.clientY - drag.sy, 0, window.innerHeight - ph) + 'px';
            panelEl.style.right = 'auto';
            panelEl.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => { drag = null; });
    }

    // ==================== 7. 路由变化 ====================

    /** SPA 切换视频时重置抓取数据 */
    let lastKey = videoKey();
    function checkRoute() {
        const key = videoKey();
        if (key === lastKey) return;
        lastKey = key;
        store.key = '';
        store.cid = null;
        store.aid = null;
        store.bvid = null;
        store.list = [];
        store.subUrls = [];
        if (listEl) listEl.innerHTML = '';
        if (panelEl && panelEl.style.display !== 'none') {
            renderVideoInfo(getVideoInfo());
            setStatus('已切换视频，请重新点「分析字幕」', '');
        }
    }

    function patchHistory() {
        ['pushState', 'replaceState'].forEach(fn => {
            const orig = pageWindow.history[fn];
            if (typeof orig !== 'function') return;
            pageWindow.history[fn] = function () {
                const ret = orig.apply(this, arguments);
                setTimeout(checkRoute, 60);
                return ret;
            };
        });
        pageWindow.addEventListener('popstate', () => setTimeout(checkRoute, 60));
        setInterval(checkRoute, 1000);
    }

    // ==================== 入口 ====================

    function init() {
        initUI();
        patchHistory();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
