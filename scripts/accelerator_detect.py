"""Shared accelerator detection helpers for environment checks and alignment.

Both ``check-accelerator.py`` and ``align_jp.py`` need the same GPU/accelerator
probes; keeping them in one module avoids two copies drifting apart.
"""

import os
import platform
import shutil
import subprocess

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
