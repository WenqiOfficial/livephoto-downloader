// ==UserScript==
// @name         Photoplus 深度同步助手
// @namespace    livephoto.downloader
// @version      1.0.0
// @author       UnknownWho
// @description  捕获活动、相册与原图链接，推送本地多线程同步下载。
// @match        https://live.photoplus.cn/live/pc/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
    "use strict";

    const BASE_URL = "__BASE_URL__";
    const STATE = {
        activityName: "未命名活动",
        albumMap: {},
        photoSet: new Set(),
        queue: [],
        scrollTimer: null,
        lastHeight: 0,
        stallCount: 0,
        eventSource: null,
        pollTimer: null,
    };

    function $(id) {
        return document.getElementById(id);
    }

    function createPanel() {
        const panel = document.createElement("div");
        panel.id = "photoplus-panel";
        panel.style.cssText = [
            "position:fixed",
            "top:80px",
            "right:20px",
            "z-index:99999",
            "width:280px",
            "border-radius:16px",
            "background:linear-gradient(160deg,#ffffff,#f6efe7)",
            "box-shadow:0 18px 40px rgba(33,25,15,0.2)",
            "border:1px solid rgba(0,0,0,0.05)",
            "font-family:'Segoe UI','Microsoft YaHei',sans-serif",
            "color:#2b2119",
        ].join(";");

        panel.innerHTML = `
            <div id="photoplus-header" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(0,0,0,0.05);cursor:move;user-select:none;">
                <div>
                    <div style="font-weight:700;letter-spacing:1px;">Photoplus Sync</div>
                    <div id="photoplus-act-name" style="font-size:11px;color:#6a5f56;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">识别中...</div>
                </div>
                <button id="photoplus-close" style="border:none;background:#f0e7de;border-radius:10px;padding:6px 10px;cursor:pointer;font-size:12px;">收起</button>
            </div>
            <div style="padding:12px 16px 8px;display:grid;gap:10px;">
                <div style="padding:12px;border-radius:12px;background:#fff;display:flex;align-items:center;justify-content:space-between;">
                    <div>
                        <div style="font-size:11px;color:#7a6f67;">捕获数量</div>
                        <div style="font-size:26px;font-weight:700;color:#ff6a3d;" id="photoplus-count">0</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:11px;color:#7a6f67;">连接状态</div>
                        <div id="photoplus-backend" style="font-size:12px;color:#a6533a;font-weight:600;margin-top:10px;">后端未连接</div>
                    </div>
                </div>
                <div style="padding:12px;border-radius:12px;background:#fff;">
                    <div style="display:flex;justify-content:space-between;font-size:11px;color:#7a6f67;">
                        <span>下载进度</span>
                        <span id="photoplus-progress-text">等待同步...</span>
                    </div>
                    <div style="height:8px;border-radius:999px;background:#f0e7de;overflow:hidden;margin-top:8px;">
                        <div id="photoplus-progress" style="height:100%;width:0;background:linear-gradient(90deg,#ff6a3d,#ffa45d);transition:width 0.3s ease;"></div>
                    </div>
                    <div style="margin-top:8px;font-size:11px;color:#7a6f67;">当前：<span id="photoplus-current">-</span></div>
                </div>
            </div>
            <div style="padding:0 16px 14px;display:grid;gap:8px;">
                <button id="photoplus-sync-btn" style="width:100%;padding:12px;border:none;border-radius:12px;background:#ff6a3d;color:#fff;font-weight:700;cursor:pointer;">一键同步至本地</button>
                <button id="photoplus-scroll-btn" style="width:100%;padding:10px;border:none;border-radius:12px;background:#2b2119;color:#fff;font-weight:600;cursor:pointer;">自动翻页到底部</button>
                <div id="photoplus-tips" style="font-size:11px;color:#7a6f67;text-align:center;">滚动或切换相册即可捕获</div>
            </div>
        `;

        document.body.appendChild(panel);
        const restore = createRestoreButton();
        $("photoplus-close").onclick = () => {
            panel.style.display = "none";
            restore.style.display = "flex";
        };
        restore.onclick = () => {
            panel.style.display = "block";
            restore.style.display = "none";
        };
    }

    function createRestoreButton() {
        let restore = $("photoplus-restore");
        if (restore) return restore;
        restore = document.createElement("button");
        restore.id = "photoplus-restore";
        restore.textContent = "Photoplus";
        restore.style.cssText = [
            "position:fixed",
            "right:20px",
            "bottom:24px",
            "z-index:99999",
            "display:none",
            "align-items:center",
            "gap:6px",
            "padding:10px 14px",
            "border:none",
            "border-radius:999px",
            "background:#ff6a3d",
            "color:#fff",
            "font-weight:700",
            "cursor:pointer",
            "box-shadow:0 12px 24px rgba(255,106,61,0.3)",
        ].join(";");
        document.body.appendChild(restore);
        return restore;
    }

    function enableDrag() {
        const panel = $("photoplus-panel");
        const header = $("photoplus-header");
        if (!panel || !header) return;

        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        header.addEventListener("mousedown", (event) => {
            if (event.button !== 0) return;
            const rect = panel.getBoundingClientRect();
            panel.style.left = rect.left + "px";
            panel.style.top = rect.top + "px";
            panel.style.right = "auto";
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            dragging = true;
        });

        document.addEventListener("mousemove", (event) => {
            if (!dragging) return;
            const maxLeft = window.innerWidth - panel.offsetWidth;
            const maxTop = window.innerHeight - panel.offsetHeight;
            const left = Math.min(Math.max(0, event.clientX - offsetX), Math.max(0, maxLeft));
            const top = Math.min(Math.max(0, event.clientY - offsetY), Math.max(0, maxTop));
            panel.style.left = left + "px";
            panel.style.top = top + "px";
        });

        document.addEventListener("mouseup", () => {
            dragging = false;
        });
    }

    function setBackendStatus(online) {
        const label = $("photoplus-backend");
        if (!label) return;
        label.textContent = online ? "后端已连接" : "后端未连接";
        label.style.color = online ? "#3c7a4b" : "#a6533a";
    }

    function updateProgressBar(state) {
        const total = state.total || 0;
        const completed = state.completed || 0;
        const failed = state.failed || 0;
        const finished = state.finished || false;
        const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
        const bar = $("photoplus-progress");
        const text = $("photoplus-progress-text");
        const current = $("photoplus-current");
        if (bar) bar.style.width = percent + "%";
        if (text) {
            if (total === 0) {
                text.textContent = "等待同步...";
            } else if (finished) {
                text.textContent = `完成 ${completed}/${total}，失败 ${failed} ✔`;
            } else {
                text.textContent = `完成 ${completed}/${total}，失败 ${failed}`;
            }
        }
        if (current) {
            current.textContent = finished ? "全部完成" : (state.current || "-");
        }
    }

    function autoScrollToBottom() {
        if (STATE.scrollTimer) return;
        const button = $("photoplus-scroll-btn");
        if (button) {
            button.disabled = true;
            button.textContent = "自动翻页中...";
        }

        const container = document.querySelector("div.container");
        if (!container) {
            if (button) {
                button.textContent = "未找到容器";
                setTimeout(() => {
                    button.disabled = false;
                    button.textContent = "自动翻页到底部";
                }, 1500);
            }
            return;
        }

        STATE.lastHeight = 0;
        STATE.stallCount = 0;
        STATE.scrollTimer = setInterval(() => {
            const height = container.scrollHeight || 0;
            container.scrollBy({ top: 1800, behavior: "smooth" });
            if (height === STATE.lastHeight) {
                STATE.stallCount += 1;
                if (STATE.stallCount >= 5) {
                    clearInterval(STATE.scrollTimer);
                    STATE.scrollTimer = null;
                    if (button) {
                        button.textContent = "已到达底部";
                        setTimeout(() => {
                            button.disabled = false;
                            button.textContent = "自动翻页到底部";
                        }, 1500);
                    }
                }
            } else {
                STATE.stallCount = 0;
                STATE.lastHeight = height;
            }
        }, 800);
    }

    function connectSSE() {
        if (STATE.eventSource) {
            STATE.eventSource.close();
        }

        const es = new EventSource(`${BASE_URL}/events`);
        es.onopen = () => {
            setBackendStatus(true);
            if (STATE.pollTimer) {
                clearInterval(STATE.pollTimer);
                STATE.pollTimer = null;
            }
        };
        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                setBackendStatus(true);
                updateProgressBar(data);
            } catch (e) {
                // ignore
            }
        };
        es.onerror = () => {
            setBackendStatus(false);
            es.close();
            STATE.eventSource = null;
            startPolling();
        };
        STATE.eventSource = es;
    }

    function pollProgress() {
        GM_xmlhttpRequest({
            method: "GET",
            url: `${BASE_URL}/progress`,
            timeout: 3000,
            onload: (res) => {
                try {
                    const data = JSON.parse(res.responseText || "{}");
                    setBackendStatus(true);
                    updateProgressBar(data);
                } catch (e) {
                    setBackendStatus(false);
                }
            },
            onerror: () => {
                setBackendStatus(false);
            },
            ontimeout: () => {
                setBackendStatus(false);
            },
        });
    }

    function startPolling() {
        if (STATE.pollTimer) return;
        pollProgress();
        STATE.pollTimer = setInterval(pollProgress, 1000);
    }

    function checkBackendAndConnect() {
        GM_xmlhttpRequest({
            method: "GET",
            url: `${BASE_URL}/progress`,
            timeout: 3000,
            onload: (res) => {
                try {
                    const data = JSON.parse(res.responseText || "{}");
                    setBackendStatus(true);
                    updateProgressBar(data);
                    connectSSE();
                } catch (e) {
                    setBackendStatus(false);
                    startPolling();
                }
            },
            onerror: () => {
                setBackendStatus(false);
                startPolling();
            },
            ontimeout: () => {
                setBackendStatus(false);
                startPolling();
            },
        });
    }

    function hookXHR() {
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function () {
            this.addEventListener("load", () => {
                if (!this.responseURL) return;
                try {
                    const res = JSON.parse(this.responseText);

                    if (this.responseURL.includes("/live/detail") && res && res.result) {
                        STATE.activityName = res.result.name || "未命名活动";
                        const act = $("photoplus-act-name");
                        if (act) act.textContent = STATE.activityName;
                    }

                    if (this.responseURL.includes("/album/list")) {
                        const list = (res.data && res.data.list) || res.result || [];
                        list.forEach((item) => {
                            if (item && item.id) STATE.albumMap[item.id] = item.name || "默认相册";
                        });
                    }

                    if (res && res.result && res.result.pics_array) {
                        const urlObj = new URL(this.responseURL);
                        const albumKey = urlObj.searchParams.get("key") || "";
                        const albumName = STATE.albumMap[albumKey] || "默认相册";
                        res.result.pics_array.forEach((pic) => {
                            let raw = pic.origin_img || pic.big_img || pic.pic_url;
                            if (!raw) return;
                            if (raw.startsWith("//")) raw = "https:" + raw;

                            const fileName = pic.pic_name || `${pic.id}.jpg`;
                            const payload = {
                                url: raw,
                                name: fileName,
                                album: albumName,
                                activity: STATE.activityName,
                            };
                            const uniqueKey = raw + albumName;

                            if (!STATE.photoSet.has(uniqueKey)) {
                                STATE.photoSet.add(uniqueKey);
                                STATE.queue.push(payload);
                                const count = $("photoplus-count");
                                if (count) count.textContent = STATE.photoSet.size;
                            }
                        });
                    }
                } catch (e) {
                    // ignore
                }
            });
            return originalSend.apply(this, arguments);
        };
    }

    function syncViaHttp(queue, button) {
        GM_xmlhttpRequest({
            method: "POST",
            url: `${BASE_URL}/sync`,
            data: JSON.stringify(queue),
            headers: { "Content-Type": "application/json" },
            onload: (res) => {
                try {
                    const data = JSON.parse(res.responseText || "{}");
                    if (data.status === "ok") {
                        STATE.queue = [];
                        if (button) {
                            button.textContent = "同步成功";
                            button.disabled = false;
                            setTimeout(() => { button.textContent = "一键同步至本地"; }, 1600);
                        }
                    } else {
                        throw new Error("sync failed");
                    }
                } catch (e) {
                    if (button) {
                        button.textContent = "同步失败";
                        button.disabled = false;
                        setTimeout(() => { button.textContent = "重试同步"; }, 1600);
                    }
                }
            },
            onerror: () => {
                alert("连接失败，请确认 Python 服务已启动。");
                if (button) {
                    button.disabled = false;
                    button.textContent = "重试同步";
                }
            },
        });
    }

    function syncToBackend() {
        const queue = STATE.queue.slice();
        if (!queue.length) {
            alert("尚未捕获新资源，请滚动页面或切换相册。");
            return;
        }

        const button = $("photoplus-sync-btn");
        if (button) {
            button.disabled = true;
            button.textContent = "正在传输...";
        }

        syncViaHttp(queue, button);
    }

    function bindEvents() {
        const syncBtn = $("photoplus-sync-btn");
        if (syncBtn) syncBtn.onclick = syncToBackend;

        const scrollBtn = $("photoplus-scroll-btn");
        if (scrollBtn) scrollBtn.onclick = autoScrollToBottom;
    }

    function init() {
        createPanel();
        enableDrag();
        hookXHR();
        bindEvents();
        checkBackendAndConnect();
    }

    init();
})();
