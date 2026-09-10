from pathlib import Path
import runpy


SOURCE = Path(__file__).resolve().parents[1] / "src" / "workbenches" / "translation-compare" / "align_jp.py"

runpy.run_path(str(SOURCE), run_name="__main__")
