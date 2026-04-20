#!/usr/bin/env python3
"""Generate matplotlib/seaborn figures for seed-regeneration tradeoff analysis."""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import seaborn as sns

ROOT = Path(__file__).resolve().parents[1]
FIGURES_DIR = ROOT / "figures"
SEED_REGEN_PATH = ROOT / "experiments" / "seed_regeneration_tradeoff_1000.json"
ENDURANCE_PATH = ROOT / "experiments" / "demo_endurance_4dir_1000_chunks.json"


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def ensure_dir() -> None:
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)


def storage_reload_time_from_endurance(endurance: dict) -> float:
    records = endurance.get("generated", [])
    storage_times = [
        float(r.get("timeMs", 0.0))
        for r in records
        if r.get("loadSource") == "storage"
    ]
    if not storage_times:
        return 0.0
    return sum(storage_times) / len(storage_times)


def make_space_time_tradeoff_figure(seed_data: dict, endurance_data: dict) -> Path:
    summary = seed_data["summary"]
    tradeoff = summary["space_tradeoff"]
    recompute = summary["recompute_time_ms"]

    full_storage_cells = float(tradeoff["persistent_storage_tile_cells"])
    seed_only_units = float(tradeoff["seed_only_scalar_units_estimate"])

    # Existing method: persistent storage reload cost is instrumentation-level 0 ms in canonical run.
    old_revisit_ms = storage_reload_time_from_endurance(endurance_data)
    new_revisit_ms = float(recompute["mean"])

    fig, axes = plt.subplots(1, 2, figsize=(14, 5.2), dpi=180)

    x_space = ["Full-grid persistence", "Seed-only persistence"]
    y_space = [full_storage_cells, seed_only_units]
    sns.barplot(
        x=x_space,
        y=y_space,
        hue=x_space,
        palette=["#5b6675", "#2a9d8f"],
        dodge=False,
        legend=False,
        ax=axes[0],
    )
    axes[0].set_yscale("log")
    axes[0].set_ylabel("Stored units (log scale)")
    axes[0].set_xlabel("Storage strategy")
    axes[0].set_title("Space comparison")
    axes[0].grid(axis="y", alpha=0.28)
    axes[0].text(
        0,
        full_storage_cells * 1.1,
        f"{int(full_storage_cells):,}",
        ha="center",
        va="bottom",
        fontsize=9,
    )
    axes[0].text(
        1,
        seed_only_units * 1.25,
        f"{int(seed_only_units):,}",
        ha="center",
        va="bottom",
        fontsize=9,
    )

    x_time = ["Full-grid reload", "Seed-only regeneration"]
    y_time = [old_revisit_ms, new_revisit_ms]
    sns.barplot(
        x=x_time,
        y=y_time,
        hue=x_time,
        palette=["#8b7752", "#8c2f39"],
        dodge=False,
        legend=False,
        ax=axes[1],
    )
    axes[1].set_ylabel("Revisit-time cost (ms)")
    axes[1].set_xlabel("Revisit strategy")
    axes[1].set_title("Time comparison")
    axes[1].grid(axis="y", alpha=0.28)
    axes[1].text(0, max(0.02, old_revisit_ms + 0.02), f"{old_revisit_ms:.2f}", ha="center", va="bottom", fontsize=9)
    axes[1].text(1, new_revisit_ms + 0.05, f"{new_revisit_ms:.2f}", ha="center", va="bottom", fontsize=9)

    fig.suptitle(
        "Space-time tradeoff: O(NG^2) persistent grids vs O(T_solve) procedural regeneration",
        fontsize=13,
        fontweight="bold",
    )
    fig.tight_layout(rect=[0, 0, 1, 0.93])

    output = FIGURES_DIR / "fig_seed_tradeoff_space_time.png"
    fig.savefig(output, bbox_inches="tight")
    plt.close(fig)
    return output


def make_determinism_figure(seed_data: dict) -> Path:
    summary = seed_data["summary"]
    checks = seed_data.get("checks", [])

    passed = int(summary["deterministic_checks_passed"])
    total = int(summary["deterministic_checks_total"])
    failed = max(0, total - passed)

    recompute_times = [
        float(c.get("recompute_time_ms", 0.0))
        for c in checks
        if c.get("executed")
    ]

    fig, axes = plt.subplots(1, 2, figsize=(14, 5.2), dpi=180)

    x_det = ["Pass", "Fail"]
    y_det = [passed, failed]
    sns.barplot(
        x=x_det,
        y=y_det,
        hue=x_det,
        palette=["#2a9d8f", "#b03a2e"],
        dodge=False,
        legend=False,
        ax=axes[0],
    )
    axes[0].set_ylabel("Checkpoint count")
    axes[0].set_xlabel("Determinism outcome")
    axes[0].set_title("Deterministic replay checks")
    axes[0].grid(axis="y", alpha=0.28)
    axes[0].text(0, passed + 1, f"{passed}/{total}", ha="center", va="bottom", fontsize=9)

    sns.histplot(
        recompute_times,
        bins=14,
        kde=True,
        color="#34699a",
        ax=axes[1],
    )
    axes[1].set_xlabel("Recompute time per checkpoint (ms)")
    axes[1].set_ylabel("Count")
    axes[1].set_title("Replay solve-time distribution")
    axes[1].grid(axis="y", alpha=0.28)

    fig.suptitle(
        "Determinism validation for coordinate-seed replay",
        fontsize=13,
        fontweight="bold",
    )
    fig.tight_layout(rect=[0, 0, 1, 0.93])

    output = FIGURES_DIR / "fig_seed_tradeoff_determinism.png"
    fig.savefig(output, bbox_inches="tight")
    plt.close(fig)
    return output


def main() -> None:
    ensure_dir()
    seed_data = load_json(SEED_REGEN_PATH)
    endurance_data = load_json(ENDURANCE_PATH)

    sns.set_theme(style="whitegrid", context="talk")

    out_a = make_space_time_tradeoff_figure(seed_data, endurance_data)
    out_b = make_determinism_figure(seed_data)

    print(json.dumps({
        "generated": [str(out_a.relative_to(ROOT)), str(out_b.relative_to(ROOT))]
    }, indent=2))


if __name__ == "__main__":
    main()
