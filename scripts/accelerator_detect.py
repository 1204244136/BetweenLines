"""Shared accelerator detection helpers for environment checks and alignment.

Both ``check-accelerator.py`` and ``align_jp.py`` need the same GPU/accelerator
probes; keeping them in one module avoids two copies drifting apart.
"""

import os
import platform
import shutil
import subprocess
from importlib import metadata

import torch


def command_output(command: list[str]) -> str:
    if not shutil.which(command[0]):
        return ""
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout if result.returncode == 0 else ""


def nvidia_devices() -> list[str]:
    output = command_output(["nvidia-smi", "-L"])
    return [line.strip() for line in output.splitlines() if line.strip().startswith("GPU ")]


def amd_devices() -> list[str]:
    devices = []

    for command in (["rocm-smi", "--showproductname"], ["rocminfo"]):
        output = command_output(command)
        for line in output.splitlines():
            stripped = line.strip()
            if any(token in stripped.lower() for token in ("amd", "radeon", "instinct", "gfx")):
                devices.append(stripped)

    if platform.system() == "Windows":
        output = command_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
            ]
        )
        for line in output.splitlines():
            stripped = line.strip()
            if any(token in stripped.lower() for token in ("amd", "radeon", "instinct")):
                devices.append(stripped)
    else:
        output = command_output(["lspci"])
        for line in output.splitlines():
            lower = line.lower()
            if any(token in lower for token in ("amd", "ati", "radeon", "instinct")) and any(
                token in lower for token in ("vga", "3d", "display")
            ):
                devices.append(line.strip())

    return sorted(set(devices))


def torch_backend() -> str:
    if getattr(torch.version, "hip", None):
        return "rocm"
    if torch.version.cuda:
        return "cuda"
    if torch.cuda.is_available():
        return "accelerator"
    return "cpu"


DEVICE_OVERRIDE_ENV = "TRANS_COMPARATOR_DEVICE"
ROCM_DEVICE_PACKAGE_PREFIXES = ("amd-torch-device-", "rocm-sdk-device-")


def normalize_arch(value: str | None) -> str:
    """把 ``gfx1201:sramecc+:xnack-`` 这类带特性的架构名归一成小写 gfx 名。"""
    return (value or "").split(":")[0].strip().lower()


def rocm_device_kernel_arches() -> list[str]:
    """返回已安装设备内核包覆盖的 gfx 架构。

    ROCm/TheRock 的 torch 本体可能带多架构编译产物，但 GPU 算子由
    ``amd-torch-device-<gfx>`` / ``rocm-sdk-device-<gfx>`` 设备内核包提供。
    在 Windows 上对没有内核包的架构 launch kernel 会直接访问违例
    （``0xC0000005``），不会抛 Python 异常，所以必须按包判断可用设备。
    """
    arches: set[str] = set()
    try:
        distributions = list(metadata.distributions())
    except Exception:
        return []

    for distribution in distributions:
        try:
            name = (distribution.metadata.get("Name") or "").strip().lower().replace("_", "-")
        except Exception:
            continue
        for prefix in ROCM_DEVICE_PACKAGE_PREFIXES:
            if name.startswith(prefix):
                arch = normalize_arch(name[len(prefix) :])
                if arch:
                    arches.add(arch)
                break
    return sorted(arches)


def torch_compiled_arches() -> list[str]:
    try:
        return sorted({normalize_arch(arch) for arch in torch.cuda.get_arch_list()})
    except Exception:
        return []


def device_arch(index: int) -> str:
    if torch_backend() == "rocm":
        props = torch.cuda.get_device_properties(index)
        return normalize_arch(getattr(props, "gcnArchName", ""))
    major, minor = torch.cuda.get_device_capability(index)
    return f"sm_{major}{minor}"


def device_supported(index: int) -> tuple[bool, str]:
    arch = device_arch(index)
    if torch_backend() != "rocm":
        # CUDA 轮子可以用 PTX 向前兼容，缺少精确 sm_XX 不代表一定跑不了；
        # 真不兼容时 PyTorch 会抛 Python 异常，不需要在这里提前拒绝。
        return True, arch

    kernels = rocm_device_kernel_arches()
    if kernels:
        return arch in kernels, arch
    compiled = torch_compiled_arches()
    return (not compiled or arch in compiled), arch


def accelerator_devices() -> list[dict]:
    """列出 PyTorch 可见设备及其架构、显存与可执行性。"""
    if not torch.cuda.is_available():
        return []

    devices = []
    for index in range(torch.cuda.device_count()):
        props = torch.cuda.get_device_properties(index)
        supported, arch = device_supported(index)
        devices.append(
            {
                "index": index,
                "name": str(getattr(props, "name", f"device {index}")),
                "arch": arch,
                "memoryMiB": int(getattr(props, "total_memory", 0) // (1024 * 1024)),
                "computeUnits": int(getattr(props, "multi_processor_count", 0) or 0),
                "supported": supported,
            }
        )
    return devices


def device_support_detail(device: dict) -> str:
    if device["supported"]:
        return "usable"

    kernels = rocm_device_kernel_arches()
    installed = ", ".join(kernels) if kernels else "none"
    return f"no {device['arch']} device kernel package installed (installed: {installed})"


def device_override_index() -> int | None:
    raw = os.environ.get(DEVICE_OVERRIDE_ENV)
    if raw is None or not raw.strip():
        return None

    text = raw.strip().lower()
    if text.startswith("cuda:"):
        text = text[len("cuda:") :]
    try:
        return int(text)
    except ValueError as exc:
        raise RuntimeError(
            f"{DEVICE_OVERRIDE_ENV} must be a device index such as 1 or cuda:1, got {raw!r}."
        ) from exc


def choose_torch_device() -> tuple[str, dict | None]:
    """选择真正能执行 kernel 的 PyTorch 设备。

    多 GPU 机器上设备顺序不保证独显在前：核显可能占 ``cuda:0``，而本机只装了
    独显架构的设备内核包。此时默认 ``cuda`` 会在 launch kernel 时原生崩溃，
    所以按设备内核包或编译架构挑选，不用 ``torch.cuda.is_available()`` 代替。
    """
    if not torch.cuda.is_available():
        return "cpu", None

    devices = accelerator_devices()
    override = device_override_index()
    if override is not None:
        device = next((item for item in devices if item["index"] == override), None)
        if device is None:
            available = ", ".join(f"cuda:{item['index']} {item['name']}" for item in devices)
            raise RuntimeError(
                f"{DEVICE_OVERRIDE_ENV}={override} but torch reports {len(devices)} device(s): {available}."
            )
        if not device["supported"]:
            raise RuntimeError(
                f"{DEVICE_OVERRIDE_ENV}={override} selects cuda:{override} {device['name']}, "
                f"which PyTorch cannot execute kernels on: {device_support_detail(device)}."
            )
        return f"cuda:{override}", device

    supported = [item for item in devices if item["supported"]]
    if not supported:
        details = "; ".join(
            f"cuda:{item['index']} {item['name']} ({item['arch']}): {device_support_detail(item)}"
            for item in devices
        )
        raise RuntimeError(
            "PyTorch cannot execute kernels on any detected accelerator: "
            f"{details}. Install the device kernel package for the GPU you want to use "
            "(ROCm: amd-torch-device-<gfx> / rocm-sdk-device-<gfx>), "
            f"set {DEVICE_OVERRIDE_ENV} to a usable index, "
            "or set TRANS_COMPARATOR_ALLOW_CPU=1 to run on CPU intentionally."
        )

    # 多块可用设备时优先计算单元更多的独显；索引只用于稳定排序。
    chosen = max(supported, key=lambda item: (item["computeUnits"], -item["index"]))
    return f"cuda:{chosen['index']}", chosen


TORCHVISION_ABSENT = "absent"
TORCHVISION_OK = "ok"
TORCHVISION_UNUSABLE = "unusable"


def torchvision_probe() -> tuple[str, str | None]:
    """Probe torchvision without letting a broken native extension escape.

    Alignment never uses torchvision, but ``transformers`` imports it whenever it is
    installed, so a wheel whose native extension was built against a different torch
    (for example a PyPI/CUDA build next to a ROCm torch) takes ``sentence_transformers``
    down with it. Returns ``(status, detail)``; status is one of the ``TORCHVISION_*``
    constants and detail is the installed version, or the exception text when unusable.
    """
    try:
        import torchvision
    except ImportError:
        return TORCHVISION_ABSENT, None
    except Exception as exc:  # RuntimeError / OSError from mismatched native ops
        return TORCHVISION_UNUSABLE, f"{type(exc).__name__}: {exc}"
    return TORCHVISION_OK, str(getattr(torchvision, "__version__", "unknown"))


def expected_backends() -> list[str]:
    backends = []
    if nvidia_devices():
        backends.append("cuda")
    if amd_devices():
        backends.append("rocm")
    return backends
