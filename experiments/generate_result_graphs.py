#!/usr/bin/env python3
"""Generate final figures from the canonical experiment bundle."""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
BUNDLE_PATH = ROOT / "experiments" / "streaming_wfc_experiment_bundle.json"
FIGURES_DIR = ROOT / "figures"


def load_bundle() -> dict:
    with BUNDLE_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def label_bars(ax, bars, fmt="{:.1f}"):
    for bar in bars:
        height = bar.get_height()
        ax.annotate(
            fmt.format(height),
            xy=(bar.get_x() + bar.get_width() / 2, height),
            xytext=(0, 4),
            textcoords="offset points",
            ha="center",
            va="bottom",
            fontsize=9,
            fontweight="bold",
        )


def save_current_figure(filename: str):
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)
    out_path = FIGURES_DIR / filename
    plt.tight_layout()
    plt.savefig(out_path, dpi=300, bbox_inches="tight")
    plt.close()
    print(f"wrote {out_path}")


def make_streaming_timing_figure(bundle: dict):
    rows = bundle["streaming_scenarios"]["rows"]
    chunk_sizes = [row["chunk_size"] for row in rows]
    times = [row["avg_generation_time_ms"] for row in rows]

    fig, ax = plt.subplots(figsize=(9, 5.5))
    ax.plot(chunk_sizes, times, "o-", linewidth=2.5, markersize=9, color="#1f77b4")
    ax.axhline(16, color="#c62828", linestyle="--", linewidth=2, label="16 ms budget")
    ax.set_xlabel("Chunk size")
    ax.set_ylabel("Mean generation time (ms)")
    ax.set_title("Streaming generation time by chunk size")
    ax.set_xticks(chunk_sizes)
    ax.set_xticklabels([f"{size}x{size}" for size in chunk_sizes])
    ax.set_yscale("log")
    ax.grid(True, alpha=0.3)
    ax.legend()

    for size, value in zip(chunk_sizes, times):
        ax.annotate(f"{value:.2f} ms", (size, value), textcoords="offset points", xytext=(6, 8), fontsize=9)

    save_current_figure("fig_streaming_timing_growth.png")


def make_solver_timing_figure(bundle: dict):
    rows = bundle["controlled_comparison"]["rows"]
    chunk_sizes = [row["size"] for row in rows]
    backtracking = [row["backtracking"]["time_ms"]["mean"] for row in rows]
    restart = [row["restart"]["time_ms"]["mean"] for row in rows]

    fig, ax = plt.subplots(figsize=(9, 5.5))
    positions = np.arange(len(chunk_sizes))
    width = 0.36
    bars_backtracking = ax.bar(positions - width / 2, backtracking, width, label="Backtracking", color="#d62728")
    bars_restart = ax.bar(positions + width / 2, restart, width, label="Restart", color="#2ca02c")
    ax.set_xlabel("Chunk size")
    ax.set_ylabel("Mean solve time (ms)")
    ax.set_title("Controlled solver comparison")
    ax.set_xticks(positions)
    ax.set_xticklabels([f"{size}x{size}" for size in chunk_sizes])
    ax.set_yscale("log")
    ax.grid(True, axis="y", alpha=0.3)
    ax.legend()
    label_bars(ax, bars_backtracking)
    label_bars(ax, bars_restart)
    save_current_figure("fig_bt_vs_restart_timing.png")


def make_attempt_comparison_figure(bundle: dict):
    rows = bundle["controlled_comparison"]["rows"]
    chunk_sizes = [row["size"] for row in rows]
    backtracking = [row["backtracking"]["attempts"]["mean"] for row in rows]
    restart = [row["restart"]["attempts"]["mean"] for row in rows]

    fig, ax = plt.subplots(figsize=(9, 5.5))
    ax.plot(chunk_sizes, backtracking, "o-", linewidth=2.5, markersize=9, color="#d62728", label="Backtracking")
    ax.plot(chunk_sizes, restart, "s-", linewidth=2.5, markersize=9, color="#2ca02c", label="Restart")
    ax.set_xlabel("Chunk size")
    ax.set_ylabel("Mean attempts per solve")
    ax.set_title("Attempt-count comparison")
    ax.set_xticks(chunk_sizes)
    ax.set_xticklabels([f"{size}x{size}" for size in chunk_sizes])
    ax.grid(True, alpha=0.3)
    ax.legend()

    for size, value in zip(chunk_sizes, backtracking):
        ax.annotate(f"{value:.2f}", (size, value), textcoords="offset points", xytext=(-14, -18), fontsize=9)
    for size, value in zip(chunk_sizes, restart):
        ax.annotate(f"{value:.2f}", (size, value), textcoords="offset points", xytext=(6, 8), fontsize=9)

    save_current_figure("fig_attempt_count_comparison.png")


def make_halo_timing_figure(bundle: dict):
    rows = bundle["halo_ablation"]["rows"]
    chunk_sizes = [row["size"] for row in rows]
    halo0 = [row["halo_0"]["time_ms"]["mean"] for row in rows]
    halo2 = [row["halo_2"]["time_ms"]["mean"] for row in rows]

    fig, ax = plt.subplots(figsize=(9, 5.5))
    positions = np.arange(len(chunk_sizes))
    width = 0.36
    bars_halo0 = ax.bar(positions - width / 2, halo0, width, label="Halo = 0", color="#9467bd")
    bars_halo2 = ax.bar(positions + width / 2, halo2, width, label="Halo = 2", color="#ff7f0e")
    ax.set_xlabel("Chunk size")
    ax.set_ylabel("Mean solve time (ms)")
    ax.set_title("Halo ablation timing")
    ax.set_xticks(positions)
    ax.set_xticklabels([f"{size}x{size}" for size in chunk_sizes])
    ax.grid(True, axis="y", alpha=0.3)
    ax.legend()
    label_bars(ax, bars_halo0)
    label_bars(ax, bars_halo2)
    save_current_figure("fig_halo_ablation_timing.png")


def make_backtrack_depth_figure(bundle: dict):
    rows = bundle["controlled_comparison"]["rows"]
    chunk_sizes = [row["size"] for row in rows]
    backtracks = [row["backtracking"]["backtracks"]["mean"] for row in rows]

    fig, ax = plt.subplots(figsize=(9, 5.5))
    bars = ax.bar(chunk_sizes, backtracks, color="#ff7f0e", edgecolor="black", linewidth=1.2)
    ax.set_xlabel("Chunk size")
    ax.set_ylabel("Mean backtracks")
    ax.set_title("Backtracking search depth")
    ax.set_xticks(chunk_sizes)
    ax.set_xticklabels([f"{size}x{size}" for size in chunk_sizes])
    ax.grid(True, axis="y", alpha=0.3)
    label_bars(ax, bars)
    save_current_figure("fig_backtrack_depth.png")


def main():
    bundle = load_bundle()
    make_streaming_timing_figure(bundle)
    make_solver_timing_figure(bundle)
    make_attempt_comparison_figure(bundle)
    make_halo_timing_figure(bundle)
    make_backtrack_depth_figure(bundle)


if __name__ == "__main__":
    main()
