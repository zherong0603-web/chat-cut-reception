"""Opt-in bridge to the existing Node Playwright SDK; never a reception worker."""

import json
import os
from pathlib import Path
import signal
import subprocess


OFFICIAL_URL = "https://sxt.xiaohongshu.com/im/login"


def probe(project_root, *, allow_isolated_browser=False,
          node_executable=None, playwright_module=None):
    result = {
        "mode": "isolated_browser_dom_probe_only", "url": OFFICIAL_URL,
        "browser_started": False, "network_requested": False,
        "live_reception_ready": False,
        "five_second_reception_acceptance": "unverified",
        "measurement_scope": "startup_minimal_dom_only_not_idle_stability",
        "sends_or_takeovers": False,
    }
    if allow_isolated_browser is not True:
        result.update(status="BLOCKED_BY_HUMAN",
                      reason="explicit_user_exception_to_iab_only_rule_required",
                      detail="须明确批准独立浏览器并显式启用；默认不启动、不访问网页、不写运行证据。")
        return result, 3

    # Explicit task configuration, without installing SDKs or discovering user browsers.
    node_executable = node_executable or os.environ.get("XHS_PROBE_NODE_EXECUTABLE")
    playwright_module = playwright_module or os.environ.get("XHS_PROBE_PLAYWRIGHT_MODULE")
    if not node_executable or not playwright_module:
        result.update(status="blocked", error="missing_dependency_configuration",
                      required_parameters=["--node-executable", "--playwright-module"],
                      detail="传入已有 Node 可执行文件和 Playwright 入口文件；不安装依赖。")
        return result, 3
    node = Path(node_executable).expanduser()
    module = Path(playwright_module).expanduser()
    if not node.is_absolute() or not module.is_absolute() or not node.is_file() or not os.access(str(node), os.X_OK) or not module.is_file():
        result.update(status="blocked", error="missing_dependency",
                      detail="Node 和 Playwright 入口必须为已存在的绝对文件路径，且 Node 可执行。")
        return result, 3
    helper = Path(__file__).with_name("browser_probe.cjs").resolve()
    if Path(project_root).resolve() != helper.parents[1]:
        result.update(status="blocked", error="unsafe_profile_root")
        return result, 3
    child = None
    try:
        child = subprocess.Popen(
            [str(node), str(helper), "--allow-isolated-browser", "--playwright-module", str(module)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
        )
        stdout, stderr = child.communicate(timeout=60)
        observed = json.loads(stdout)
        if not isinstance(observed, dict):
            raise ValueError("probe helper did not return an object")
        return observed, child.returncode if child.returncode in (0, 3) else 3
    except subprocess.TimeoutExpired:
        # Kill only this newly spawned isolated process group, never user apps.
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
        result.update(status="failed", error="probe_process_timeout",
                      browser_started=None, network_requested=None,
                      detail="隔离预检超时；已终止本次专属子进程组，未能确定测量结果。")
        return result, 3
    except (OSError, ValueError) as error:
        result.update(status="failed", error="probe_helper_failed", detail=str(error)[:2000])
        if child is not None:
            result.update(browser_started=None, network_requested=None)
        return result, 3
