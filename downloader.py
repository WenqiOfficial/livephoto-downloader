import configparser
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from flask import Flask, Response, render_template_string, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.conf")
SCRIPT_FILE = os.path.join(BASE_DIR, "script", "install.user.js")

DEFAULT_CONFIG = {
    "server": {
        "host": "127.0.0.1",
        "port": "5000",
    },
    "download": {
        "root": "Downloads",
        "threads": "8",
        "timeout": "30",
    },
}

app = Flask(__name__)

progress_lock = threading.Lock()
progress_state = {
    "total": 0,
    "completed": 0,
    "failed": 0,
    "current": "",
    "finished": False,
    "updated_at": 0,
}

executor_lock = threading.Lock()
executor = None
executor_workers = 0


def ensure_config():
    if os.path.exists(CONFIG_FILE):
        return
    config = configparser.ConfigParser()
    for section, values in DEFAULT_CONFIG.items():
        config[section] = values
    with open(CONFIG_FILE, "w", encoding="utf-8") as handle:
        config.write(handle)


def load_config():
    ensure_config()
    config = configparser.ConfigParser()
    config.read(CONFIG_FILE, encoding="utf-8")
    return config


def sanitize_name(value: str) -> str:
    return re.sub(r"[\\/:*?\"<>|]", "_", value or "")


def read_user_script(base_url: str) -> str:
    if not os.path.exists(SCRIPT_FILE):
        return "// install.user.js is missing."
    with open(SCRIPT_FILE, "r", encoding="utf-8") as handle:
        content = handle.read()
    return content.replace("__BASE_URL__", base_url)


def snapshot_progress() -> dict:
    with progress_lock:
        return dict(progress_state)


def update_progress(**kwargs):
    with progress_lock:
        progress_state.update(kwargs)
        progress_state["updated_at"] = int(time.time())


def increment_progress(success: bool, current: str = ""):
    with progress_lock:
        if success:
            progress_state["completed"] += 1
        else:
            progress_state["failed"] += 1
        progress_state["current"] = current
        progress_state["updated_at"] = int(time.time())
        total = progress_state["total"]
        done = progress_state["completed"] + progress_state["failed"]
        if total > 0 and done >= total:
            progress_state["finished"] = True


def build_download_path(root_dir: str, activity: str, album: str, name: str) -> str:
    safe_activity = sanitize_name(activity) or "未命名活动"
    safe_album = sanitize_name(album) or "默认相册"
    safe_name = sanitize_name(name) or "unnamed.jpg"
    target_dir = os.path.join(root_dir, safe_activity, safe_album)
    os.makedirs(target_dir, exist_ok=True)
    return os.path.join(target_dir, safe_name)


def download_task(item: dict, root_dir: str, timeout: int):
    url = item.get("url", "")
    name = item.get("name", "")
    album = item.get("album", "")
    activity = item.get("activity", "")
    target_path = build_download_path(root_dir, activity, album, name)

    if os.path.exists(target_path):
        increment_progress(True, current=name)
        return

    try:
        with progress_lock:
            progress_state["current"] = name
        response = requests.get(
            url,
            timeout=timeout,
            headers={"User-Agent": "Mozilla/5.0"},
            stream=True,
        )
        if response.status_code != 200:
            increment_progress(False, current=name)
            return

        total_written = 0
        with open(target_path, "wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 128):
                if not chunk:
                    continue
                handle.write(chunk)
                total_written += len(chunk)

        if total_written < 100:
            try:
                os.remove(target_path)
            except OSError:
                pass
            increment_progress(False, current=name)
            return

        increment_progress(True, current=name)
    except Exception:
        try:
            if os.path.exists(target_path):
                os.remove(target_path)
        except OSError:
            pass
        increment_progress(False, current=name)


def get_executor(max_workers: int) -> ThreadPoolExecutor:
    global executor, executor_workers
    with executor_lock:
        if executor is None or executor_workers != max_workers:
            if executor is not None:
                executor.shutdown(wait=False, cancel_futures=False)
            executor = ThreadPoolExecutor(max_workers=max_workers)
            executor_workers = max_workers
        return executor


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


@app.route("/")
def index():
    config = load_config()
    root_dir = os.path.join(BASE_DIR, config.get("download", "root"))
    base_url = f"http://{config.get('server', 'host')}:{config.get('server', 'port')}"
    return render_template_string(
        """
        <!doctype html>
        <html lang="zh">
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width,initial-scale=1" />
            <title>Photoplus 下载同步服务</title>
            <style>
                :root {
                    --bg: #f4f1ec;
                    --card: #ffffff;
                    --ink: #1c1c1c;
                    --muted: #6f6a64;
                    --accent: #ff6a3d;
                    --accent-dark: #e55a30;
                }
                * { box-sizing: border-box; }
                body {
                    margin: 0;
                    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
                    background: radial-gradient(circle at top, #fff, var(--bg));
                    color: var(--ink);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 40px 16px;
                }
                .card {
                    width: min(720px, 92vw);
                    background: var(--card);
                    border-radius: 24px;
                    padding: 36px;
                    box-shadow: 0 25px 70px rgba(38, 30, 22, 0.15);
                    border: 1px solid rgba(0, 0, 0, 0.04);
                }
                .badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 12px;
                    text-transform: uppercase;
                    letter-spacing: 2px;
                    color: var(--muted);
                }
                h1 {
                    font-size: 32px;
                    margin: 12px 0 6px;
                }
                p { color: var(--muted); line-height: 1.6; }
                .meta {
                    margin: 20px 0;
                    padding: 16px;
                    border-radius: 14px;
                    background: #faf7f2;
                }
                .meta strong { color: var(--ink); }
                .cta {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 14px 26px;
                    background: var(--accent);
                    color: #fff;
                    text-decoration: none;
                    font-weight: 700;
                    border-radius: 14px;
                    transition: transform 0.2s ease, box-shadow 0.2s ease;
                }
                .cta:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 14px 28px rgba(255, 106, 61, 0.3);
                    background: var(--accent-dark);
                }
                .grid {
                    display: grid;
                    gap: 14px;
                    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                    margin-top: 18px;
                }
                .pill {
                    background: #f1ebe2;
                    border-radius: 12px;
                    padding: 12px 14px;
                    font-size: 13px;
                    color: var(--muted);
                }
                code { background: #f1ebe2; padding: 2px 6px; border-radius: 6px; }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="badge">LIVEPHOTO DOWNLOADER</div>
                <h1>Photoplus 高清原图同步服务</h1>
                <p>本地服务已启动。点击按钮安装油猴脚本，即可从网页端一键同步原图。</p>
                <div class="meta">
                    <div><strong>服务地址：</strong>{{ base_url }}</div>
                    <div><strong>下载根目录：</strong><code>{{ root_dir }}</code></div>
                </div>
                <a class="cta" href="/install.user.js">安装 / 更新油猴脚本</a>
                <div class="grid">
                    <div class="pill">自动按 活动/相册/文件名 归档</div>
                    <div class="pill">多线程下载，默认 8 线程</div>
                    <div class="pill">支持断点式重复调用，已存在自动跳过</div>
                </div>
            </div>
        </body>
        </html>
        """,
        base_url=base_url,
        root_dir=root_dir,
    )


@app.route("/install.user.js")
def install():
    config = load_config()
    base_url = f"http://{config.get('server', 'host')}:{config.get('server', 'port')}"
    content = read_user_script(base_url)
    return Response(content, mimetype="text/javascript")


@app.route("/sync", methods=["POST", "OPTIONS"])
def sync():
    if request.method == "OPTIONS":
        return Response(status=204)

    items = request.get_json(silent=True) or []
    if not isinstance(items, list):
        return {"status": "error", "message": "Invalid payload"}, 400

    total = start_sync(items)
    return {"status": "ok", "total": total}


@app.route("/progress")
def progress():
    data = snapshot_progress()
    return Response(json.dumps(data, ensure_ascii=False), mimetype="application/json")


@app.route("/events")
def events():
    def generate():
        last_updated = 0
        while True:
            data = snapshot_progress()
            if data["updated_at"] != last_updated:
                last_updated = data["updated_at"]
                yield f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
            time.sleep(0.5)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def start_sync(items: list) -> int:
    config = load_config()
    root_dir = os.path.join(BASE_DIR, config.get("download", "root"))
    threads = int(config.get("download", "threads"))
    timeout = int(config.get("download", "timeout"))
    total = len(items)
    update_progress(total=total, completed=0, failed=0, current="", finished=False)
    executor = get_executor(threads)
    for item in items:
        executor.submit(download_task, item, root_dir, timeout)
    return total


def print_banner(host: str, port: int, root_dir: str, threads: int):
    print()
    print("  ╔═══════════════════════════════════════════════════════╗")
    print("  ║         Photoplus 高清原图下载同步工具               ║")
    print("  ╚═══════════════════════════════════════════════════════╝")
    print()
    print(f"    服务地址:   http://{host}:{port}")
    print(f"    下载目录:   {root_dir}")
    print(f"    线程数量:   {threads}")
    print()
    print("    打开上方地址安装油猴脚本，然后访问 Photoplus 网站开始使用")
    print()


if __name__ == "__main__":
    config = load_config()
    root_dir = os.path.join(BASE_DIR, config.get("download", "root"))
    os.makedirs(root_dir, exist_ok=True)
    host = config.get("server", "host")
    port = int(config.get("server", "port"))
    threads = int(config.get("download", "threads"))
    print_banner(host, port, root_dir, threads)
    app.run(host=host, port=port, threaded=True)