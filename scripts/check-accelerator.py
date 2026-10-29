import os
import sys

import torch

from accelerator_detect import (
    TORCHVISION_ABSENT,
    TORCHVISION_UNUSABLE,
    accelerator_devices,
    choose_torch_device,
    device_support_detail,
    expected_backends,
    torch_backend,
    torchvision_probe,
)


ALLOW_CPU = os.environ.get("TRANS_COMPARATOR_ALLOW_CPU") == "1"


def torchvision_repair_hint(backend: str) -> str:
    if backend == "rocm":
        return (
            "从与本机 ROCm 构建同源的索引重装 torchvision"
            "（TheRock 多架构索引 https://rocm.nightlies.amd.com/whl-multi-arch/，版本需与 torch 对应）"
        )
    if backend == "cuda":
        return "用与本机 CUDA 轮子相同的索引重装 torchvision（https://download.pytorch.org/whl/ 下对应的 cuXXX）"
    return "用与 torch 相同的来源重装 torchvision"


def report_torchvision(backend: str) -> None:
    """Report torchvision state; unusable is a warning, not a gate.

    The alignment pipeline works without torchvision, so a broken wheel must not fail
    this check. It still gets reported loudly because ``transformers`` imports
    torchvision whenever it is installed and fails with it.
    """
    status, detail = torchvision_probe()

    if status == TORCHVISION_ABSENT:
        print("torchvision: not installed (optional; alignment does not need it)")
        return

    if status != TORCHVISION_UNUSABLE:
        print(f"torchvision: {detail}")
        return

    print(f"torchvision: installed but unusable - {detail}", file=sys.stderr)
    print(
        "torchvision 的原生扩展与本机 torch 的 ABI 不一致；"
        "torch / torchvision / torchaudio 必须来自同一次安装、同一来源。",
        file=sys.stderr,
    )
    print(
        "对齐流程本身不需要 torchvision，但 transformers 会在导入时连带失败。",
        file=sys.stderr,
    )
    print(
        f"处置：{torchvision_repair_hint(backend)}；确认不再需要时可 pip uninstall torchvision。",
        file=sys.stderr,
    )
    print(
        "详见 docs/contracts/troubleshooting.md 的「环境与加速器异常」。",
        file=sys.stderr,
    )


def report_devices() -> None:
    """逐块列出 PyTorch 设备；多 GPU 时设备 0 不一定是能跑 kernel 的独显。"""
    devices = accelerator_devices()
    if not devices:
        return

    print(f"torch devices: {len(devices)}")
    for device in devices:
        print(
            f"device cuda:{device['index']}: {device['name']} "
            f"({device['arch']}, {device['memoryMiB']} MiB) - {device_support_detail(device)}"
        )


def main() -> int:
    backend = torch_backend()
    expected = expected_backends()
    accelerator_available = torch.cuda.is_available()

    print(f"torch: {torch.__version__}")
    print(f"torch.version.cuda: {torch.version.cuda}")
    print(f"torch.version.hip: {getattr(torch.version, 'hip', None)}")
    print(f"torch accelerator built: {backend != 'cpu'}")
    print(f"torch accelerator available: {accelerator_available}")
    print(f"detected accelerator backends: {', '.join(expected) if expected else 'none'}")
    report_torchvision(backend)
    report_devices()

    if accelerator_available:
        try:
            device, info = choose_torch_device()
        except RuntimeError as exc:
            if ALLOW_CPU:
                print(f"warning: {exc}", file=sys.stderr)
                print("accelerator backend: cpu (explicitly allowed by TRANS_COMPARATOR_ALLOW_CPU=1)")
                return 0
            print(str(exc), file=sys.stderr)
            return 1

        print(f"accelerator backend: {backend}")
        print(f"selected device: {device}")
        if info is not None:
            print(f"gpu: {info['name']}")
        return 0

    if expected and not ALLOW_CPU:
        print(
            "\nGPU accelerator hardware was detected, but this Python environment cannot use it.",
            file=sys.stderr,
        )
        print(
            f"Expected backend(s): {', '.join(expected)}. Installed PyTorch backend: {backend}.",
            file=sys.stderr,
        )
        print(
            "Install a matching PyTorch CUDA/ROCm wheel, or set TRANS_COMPARATOR_ALLOW_CPU=1 to run on CPU intentionally.",
            file=sys.stderr,
        )
        return 1

    if expected:
        print("GPU accelerator hardware detected, but CPU mode was explicitly allowed.")
    else:
        print("No NVIDIA CUDA or AMD ROCm accelerator was detected by local probes; CPU mode is expected.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
