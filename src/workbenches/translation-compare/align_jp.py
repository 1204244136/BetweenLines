import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import numpy as np
import torch

from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from accelerator_detect import expected_backends, torch_backend


OUT = Path(os.environ.get("TRANSCOMPARATOR_OUTPUT_DIR", ROOT / "out" / "runtime" / "work")).resolve()
PARAGRAPHS = OUT / "paragraphs.json"
ALIGNMENT = OUT / "jp-align.json"

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
PIVOT_LANG = os.environ.get("TRANS_COMPARATOR_JP_PIVOT", "cn")
BATCH_SIZE = 32
REPORT_BATCH_SIZE = 256
SEARCH_WINDOW = 24
MAX_CHARS = 420
PROGRESS_ENV = os.environ.get("TRANS_COMPARATOR_PROGRESS")
SHOW_PROGRESS = PROGRESS_ENV.lower() not in ("0", "false", "no") if PROGRESS_ENV is not None else sys.stderr.isatty()
MACHINE_PROGRESS = os.environ.get("TRANS_COMPARATOR_MACHINE_PROGRESS") == "1"
PROGRESS_PREFIX = "@@transcomparator-progress@@"
MOVES = (
    (1, 1),
    (1, 2),
    (2, 1),
    (2, 2),
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


def select_device() -> str:
    print(f"torch: {torch.__version__}")
    print(f"torch.version.cuda: {torch.version.cuda}")
    print(f"torch.version.hip: {getattr(torch.version, 'hip', None)}")

    if torch.cuda.is_available():
        return "cuda"

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

    return "cpu"


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


def align_groups(jp_vecs: np.ndarray, pivot_vecs: np.ndarray) -> list[dict]:
    jp_count = len(jp_vecs)
    pivot_count = len(pivot_vecs)
    neg = -1e9
    dp = np.full((jp_count + 1, pivot_count + 1), neg, dtype=np.float32)
    trace = np.full((jp_count + 1, pivot_count + 1, 2), -1, dtype=np.int16)
    dp[0, 0] = 0

    for i in range(jp_count + 1):
        if i % max(1, jp_count // 100) == 0 or i == jp_count:
            report_progress(70 + (27 * i / max(1, jp_count)), "生成稳定对齐组", i, jp_count)
        expected = round((i / max(1, jp_count)) * pivot_count)
        j_start = max(0, expected - SEARCH_WINDOW)
        j_end = min(pivot_count, expected + SEARCH_WINDOW)

        for j in range(j_start, j_end + 1):
            if dp[i, j] <= neg / 2:
                continue

            for jp_step, pivot_step in MOVES:
                ni = i + jp_step
                nj = j + pivot_step
                if ni > jp_count or nj > pivot_count:
                    continue

                next_expected = round((ni / max(1, jp_count)) * pivot_count)
                if abs(nj - next_expected) > SEARCH_WINDOW:
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
    device = select_device()
    print(f"device: {device}")
    if device == "cuda":
        print(f"gpu: {torch.cuda.get_device_name(0)}")

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
        "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None,
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
