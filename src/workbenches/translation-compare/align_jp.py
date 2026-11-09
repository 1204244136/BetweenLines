import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from accelerator_detect import (  # noqa: E402
    TORCHVISION_UNUSABLE,
    choose_torch_device,
    expected_backends,
    torch_backend,
    torchvision_probe,
)


def _shield_broken_torchvision() -> None:
    """Alignment never uses torchvision, but transformers imports it whenever it is installed.

    A torchvision wheel built against a different torch (e.g. CUDA wheel next to ROCm torch)
    raises ``RuntimeError: operator torchvision::nms does not exist`` at import time and takes
    ``sentence_transformers`` down with it. Probe it once; if it is broken, mark it as absent
    so ``importlib.util.find_spec("torchvision")`` returns None and transformers skips it.
    """
    status, detail = torchvision_probe()
    if status != TORCHVISION_UNUSABLE:
        return

    sys.modules["torchvision"] = None  # type: ignore[assignment]
    print(
        f"warning: torchvision is installed but unusable ({detail}); "
        "continuing without it (alignment does not need torchvision).",
        file=sys.stderr,
    )


_shield_broken_torchvision()

from sentence_transformers import SentenceTransformer  # noqa: E402


OUT = Path(os.environ.get("TRANSCOMPARATOR_OUTPUT_DIR", ROOT / "out" / "runtime" / "work")).resolve()
PARAGRAPHS = OUT / "paragraphs.json"
ALIGNMENT = OUT / "jp-align.json"

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
PIVOT_LANG = os.environ.get("TRANS_COMPARATOR_JP_PIVOT", "cn")
BATCH_SIZE = 32
REPORT_BATCH_SIZE = 256
SEARCH_WINDOW = 24
BAND_MARGIN = 16
MAX_CHARS = 420
PROGRESS_ENV = os.environ.get("TRANS_COMPARATOR_PROGRESS")
SHOW_PROGRESS = PROGRESS_ENV.lower() not in ("0", "false", "no") if PROGRESS_ENV is not None else sys.stderr.isatty()
MACHINE_PROGRESS = os.environ.get("TRANS_COMPARATOR_MACHINE_PROGRESS") == "1"
PROGRESS_PREFIX = "@@transcomparator-progress@@"
# 原文段落是表格行的最小单位：一张表格行只对应一段原文。
# 译文侧允许拆并（1:2、0:1、1:0），但不允许换序：旧实现先用 2:2 暂存再按相似度
# 互换，回填时会产生 pivotStart 回退的交叉区间，写回只能按行序定位，必然错位。
MOVES = (
    (1, 1),
    (1, 2),
    (1, 0),
    (0, 1),
)


def configure_console_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except OSError:
                pass


def configure_progress_output() -> None:
    from transformers.utils import logging as transformers_logging

    if SHOW_PROGRESS:
        transformers_logging.enable_progress_bar()
    else:
        transformers_logging.disable_progress_bar()


def report_progress(percent: float, label: str, current: int = 0, total: int = 0) -> None:
    if not MACHINE_PROGRESS:
        return
    payload = {
        "percent": round(max(0.0, min(100.0, percent)), 1),
        "label": label,
        "current": current,
        "total": total,
    }
    print(f"{PROGRESS_PREFIX}{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}", flush=True)


def select_device() -> tuple[str, dict | None]:
    print(f"torch: {torch.__version__}")
    print(f"torch.version.cuda: {torch.version.cuda}")
    print(f"torch.version.hip: {getattr(torch.version, 'hip', None)}")

    try:
        device, info = choose_torch_device()
    except RuntimeError as exc:
        if os.environ.get("TRANS_COMPARATOR_ALLOW_CPU") == "1":
            print(f"warning: {exc}", file=sys.stderr)
            print("warning: falling back to CPU because TRANS_COMPARATOR_ALLOW_CPU=1", file=sys.stderr)
            return "cpu", None
        raise

    if info is not None:
        torch.cuda.set_device(info["index"])
        return device, info

    expected = expected_backends()
    if expected:
        print(
            "warning: GPU accelerator hardware detected, but PyTorch cannot use it. "
            "This usually means a CPU-only torch wheel or the wrong backend wheel is installed."
        )
        if os.environ.get("TRANS_COMPARATOR_ALLOW_CPU") != "1":
            raise RuntimeError(
                "Refusing to run cross-language alignment on CPU while accelerator hardware is present. "
                f"Expected backend(s): {', '.join(expected)}. Installed PyTorch backend: {torch_backend()}. "
                "Run `npm run check:accelerator` for diagnostics, install a matching CUDA/ROCm PyTorch wheel, "
                "or set TRANS_COMPARATOR_ALLOW_CPU=1 to run on CPU intentionally."
            )

    return "cpu", None


def trimmed(text: str) -> str:
    chars = list(text or "")
    return "".join(chars[:MAX_CHARS])


def encode(
    model: SentenceTransformer,
    texts: list[str],
    device: str,
    progress_start: float,
    progress_end: float,
    label: str,
) -> np.ndarray:
    trimmed_texts = [trimmed(text) for text in texts]
    total = len(trimmed_texts)
    if not total:
        report_progress(progress_end, label, 0, 0)
        return np.empty((0, model.get_sentence_embedding_dimension()), dtype=np.float32)

    if not MACHINE_PROGRESS:
        return model.encode(
            trimmed_texts,
            batch_size=BATCH_SIZE,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=SHOW_PROGRESS,
            device=device,
        )

    batches = []
    for start in range(0, total, REPORT_BATCH_SIZE):
        chunk = trimmed_texts[start : start + REPORT_BATCH_SIZE]
        batches.append(
            model.encode(
                chunk,
                batch_size=BATCH_SIZE,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
                device=device,
            )
        )
        current = min(total, start + len(chunk))
        percent = progress_start + ((progress_end - progress_start) * current / total)
        report_progress(percent, label, current, total)
    return np.concatenate(batches, axis=0)


def group_vector(vecs: np.ndarray, start: int, size: int) -> np.ndarray:
    group = vecs[start : start + size].mean(axis=0)
    norm = np.linalg.norm(group)
    return group if norm == 0 else group / norm


def group_score(jp_vecs: np.ndarray, pivot_vecs: np.ndarray, jp_start: int, jp_size: int, pivot_start: int, pivot_size: int) -> float:
    if jp_size == 0 or pivot_size == 0:
        return -0.26

    jp_group = group_vector(jp_vecs, jp_start, jp_size)
    pivot_group = group_vector(pivot_vecs, pivot_start, pivot_size)
    merge_penalty = 0.035 * max(0, jp_size + pivot_size - 2)
    return float(jp_group @ pivot_group) - merge_penalty


def alignment_band(jp_count: int, pivot_count: int) -> int:
    """搜索带至少覆盖两侧段数差造成的累计偏移。

    旧实现固定 ±SEARCH_WINDOW：当译本侧多出的段落集中在书末（后记、特典未截断等），
    按比例推算的期望位置会一路领先真实对角线，超过窗口后正确路径被裁掉，DP 只能
    提前吸收多余译文段，整卷从此错位。带宽覆盖 |pivot-jp| 后再留余量即可避免。
    """
    return max(SEARCH_WINDOW, abs(int(pivot_count) - int(jp_count)) + BAND_MARGIN)


def align_groups(jp_vecs: np.ndarray, pivot_vecs: np.ndarray) -> list[dict]:
    jp_count = len(jp_vecs)
    pivot_count = len(pivot_vecs)
    band = alignment_band(jp_count, pivot_count)
    neg = -1e9
    dp = np.full((jp_count + 1, pivot_count + 1), neg, dtype=np.float32)
    trace = np.full((jp_count + 1, pivot_count + 1, 2), -1, dtype=np.int16)
    dp[0, 0] = 0

    for i in range(jp_count + 1):
        if i % max(1, jp_count // 100) == 0 or i == jp_count:
            report_progress(70 + (27 * i / max(1, jp_count)), "生成稳定对齐组", i, jp_count)
        expected = round((i / max(1, jp_count)) * pivot_count)
        j_start = max(0, expected - band)
        j_end = min(pivot_count, expected + band)

        for j in range(j_start, j_end + 1):
            if dp[i, j] <= neg / 2:
                continue

            for jp_step, pivot_step in MOVES:
                ni = i + jp_step
                nj = j + pivot_step
                if ni > jp_count or nj > pivot_count:
                    continue

                next_expected = round((ni / max(1, jp_count)) * pivot_count)
                if abs(nj - next_expected) > band:
                    continue

                score = group_score(jp_vecs, pivot_vecs, i, jp_step, j, pivot_step)
                candidate = dp[i, j] + score
                if candidate > dp[ni, nj]:
                    dp[ni, nj] = candidate
                    trace[ni, nj] = (jp_step, pivot_step)

    groups = []
    i = jp_count
    j = pivot_count
    while i > 0 or j > 0:
        jp_step, pivot_step = trace[i, j]
        if jp_step < 0 or pivot_step < 0:
            if i > 0 and j > 0:
                jp_step, pivot_step = 1, 1
            elif i > 0:
                jp_step, pivot_step = 1, 0
            else:
                jp_step, pivot_step = 0, 1

        jp_start = i - int(jp_step)
        pivot_start = j - int(pivot_step)
        score = group_score(jp_vecs, pivot_vecs, jp_start, int(jp_step), pivot_start, int(pivot_step))
        groups.append(
            {
                "jpStart": jp_start,
                "jpEnd": i,
                "pivotStart": pivot_start,
                "pivotEnd": j,
                "score": round(float(score), 4),
                "relation": f"{int(jp_step)}:{int(pivot_step)}",
            }
        )
        i = jp_start
        j = pivot_start

    groups.reverse()
    return validate_alignment_groups(groups, jp_count, pivot_count)


def validate_alignment_groups(groups: list[dict], jp_count: int, pivot_count: int) -> list[dict]:
    """校验对齐组覆盖完整、原文一段一行且译文区间首尾相接。

    行组装与写回都按组顺序定位原文块；任何回退或跳段都会让写回找不到唯一位置。
    旧数据里的 2:2 换序组会产出交叉区间，这里显式拒绝，不再静默产出错位快照。
    """
    jp_cursor = 0
    pivot_cursor = 0
    for group in groups:
        jp_start = int(group["jpStart"])
        jp_end = int(group["jpEnd"])
        pivot_start = int(group["pivotStart"])
        pivot_end = int(group["pivotEnd"])
        if jp_start != jp_cursor or pivot_start != pivot_cursor:
            raise ValueError(
                "对齐组区间不连续："
                f"jp {jp_start}:{jp_end} / pivot {pivot_start}:{pivot_end}，"
                f"期望起点 jp={jp_cursor} pivot={pivot_cursor}"
            )
        if jp_end - jp_start > 1:
            raise ValueError(f"原文对齐组 {jp_start}:{jp_end} 含多段原文，违反一段原文一行")
        jp_cursor = jp_end
        pivot_cursor = pivot_end

    if jp_cursor != jp_count or pivot_cursor != pivot_count:
        raise ValueError(
            f"对齐组未覆盖全部段落：jp {jp_cursor}/{jp_count}，pivot {pivot_cursor}/{pivot_count}"
        )
    return groups


def main() -> None:
    report_progress(9, "加载段落数据")
    data = json.loads(PARAGRAPHS.read_text(encoding="utf-8"))
    jp = data["jp"]
    comparison_mode = data.get("comparisonMode", "trilingual")
    pivot_lang = "cn" if comparison_mode == "bilingual" else PIVOT_LANG
    if pivot_lang not in data:
        raise ValueError(f"Unknown pivot language: {pivot_lang}")
    pivot = data[pivot_lang]

    report_progress(10, "检测计算设备")
    device, device_info = select_device()
    print(f"device: {device}")
    if device_info is not None:
        print(f"gpu: {device_info['name']} ({device_info['arch']})")

    report_progress(12, "加载语义模型")
    # ROCm Windows wheel 的 fused attention（sdpa/AOTriton 后端）在部分 GPU（如 gfx1201）上
    # 会返回 hipErrorInvalidValue；强制 eager attention 绕过该 kernel，对 CPU 路径无影响。
    model = SentenceTransformer(
        MODEL_NAME,
        device=device,
        model_kwargs={"attn_implementation": "eager"},
    )
    report_progress(16, "语义模型就绪")
    jp_texts = [item["text"] for item in jp]
    pivot_texts = [item["cnText"] for item in pivot]

    # 双语模式的 pivot 列是译文 B，三语模式才是非原文列，日志按模式称呼。
    pivot_role = "译文" if comparison_mode == "bilingual" else "非原文"
    print(f"mode: {comparison_mode} (pivot={pivot_lang})")
    print("encoding jp")
    jp_vecs = encode(model, jp_texts, device, 16, 50, "编码原文向量")
    print(f"encoding {pivot_lang}")
    pivot_vecs = encode(model, pivot_texts, device, 50, 70, f"编码{pivot_role}向量")

    report_progress(70, "生成稳定对齐组", 0, len(jp_vecs))
    groups = align_groups(jp_vecs, pivot_vecs)
    result = {
        "model": MODEL_NAME,
        "pivotLang": pivot_lang,
        "comparisonMode": comparison_mode,
        "device": device,
        "torchVersion": torch.__version__,
        "torchCudaVersion": torch.version.cuda,
        "torchHipVersion": getattr(torch.version, "hip", None),
        "acceleratorBackend": torch_backend(),
        "gpu": device_info["name"] if device_info is not None else None,
        "gpuArch": device_info["arch"] if device_info is not None else None,
        "searchWindow": SEARCH_WINDOW,
        "counts": {"jp": len(jp), pivot_lang: len(pivot)},
        "groups": groups,
    }
    ALIGNMENT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    report_progress(100, "跨语言对齐完成")
    print(f"alignment: jp {len(jp)} × {pivot_lang} {len(pivot)}，{len(groups)} 个稳定对齐组")
    print(f"wrote {ALIGNMENT}")


if __name__ == "__main__":
    configure_console_output()
    configure_progress_output()
    main()
