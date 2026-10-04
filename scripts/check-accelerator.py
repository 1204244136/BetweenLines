import os
import sys

import torch

from accelerator_detect import (
    TORCHVISION_ABSENT,
    TORCHVISION_UNUSABLE,
    expected_backends,
    torch_backend,
    torchvision_probe,
)


ALLOW_CPU = os.environ.get("TRANS_COMPARATOR_ALLOW_CPU") == "1"


def device_name() -> str | None:
    if not torch.cuda.is_available():
        return None

    try:
        return torch.cuda.get_device_name(0)
    except Exception:
        return None


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


def main() -> int:
    backend = torch_backend()
    expected = expected_backends()
    accelerator_available = torch.cuda.is_available()
    gpu_name = device_name()

    print(f"torch: {torch.__version__}")
    print(f"torch.version.cuda: {torch.version.cuda}")
    print(f"torch.version.hip: {getattr(torch.version, 'hip', None)}")
    print(f"torch accelerator built: {backend != 'cpu'}")
    print(f"torch accelerator available: {accelerator_available}")
    print(f"detected accelerator backends: {', '.join(expected) if expected else 'none'}")
    report_torchvision(backend)

    if accelerator_available:
        print(f"accelerator backend: {backend}")
        if gpu_name:
            print(f"gpu: {gpu_name}")
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
