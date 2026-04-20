#!/usr/bin/env python3
"""Generate polished report figures from the canonical experiment files.

The environment used for this project does not guarantee matplotlib, so the
figure pipeline is implemented directly with Pillow. The goal is a consistent,
report-oriented visual style rather than quick diagnostic plots.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
BUNDLE_PATH = ROOT / "experiments" / "streaming_wfc_experiment_bundle.json"
BUNDLE_10_PATH = ROOT / "experiments" / "streaming_wfc_experiment_bundle_10x10.json"
BUNDLE_20_PATH = ROOT / "experiments" / "streaming_wfc_experiment_bundle_20x20.json"
ENDURANCE_PATH = ROOT / "experiments" / "demo_endurance_4dir_1000_chunks.json"
COMPLEXITY_BUNDLE_PATH = ROOT / "experiments" / "complexity_validation_bundle.json"
SEED_REGEN_PATH = ROOT / "experiments" / "seed_regeneration_tradeoff_1000.json"
FIGURES_DIR = ROOT / "figures"

WIDTH = 2400
HEIGHT = 1350
MARGIN_LEFT = 255
MARGIN_RIGHT = 110
MARGIN_TOP = 200
MARGIN_BOTTOM = 170

BG = "#ffffff"
PANEL = "#ffffff"
TEXT = "#182230"
MUTED = "#5c6675"
GRID = "#d6dce5"
AXIS = "#293241"
BT = "#8c2f39"
RESTART = "#34699a"
TEAL = "#2a9d8f"
GOLD = "#c28a2c"
SLATE = "#6b7280"
BUDGET = "#b03a2e"

# Restrained, publication-style palette.
BT = "#3f3f46"
RESTART = "#5b6675"
TEAL = "#4b7a71"
GOLD = "#8b7752"
BUDGET = "#9a3b32"


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def bundle() -> dict:
    return load_json(BUNDLE_PATH)


def bundle_pair() -> tuple[dict, dict]:
    b10 = load_json(BUNDLE_10_PATH) if BUNDLE_10_PATH.exists() else bundle()
    b20 = load_json(BUNDLE_20_PATH) if BUNDLE_20_PATH.exists() else bundle()
    return b10, b20


def endurance() -> dict:
    return load_json(ENDURANCE_PATH)


def complexity_bundle() -> dict | None:
    if COMPLEXITY_BUNDLE_PATH.exists():
        return load_json(COMPLEXITY_BUNDLE_PATH)
    return None


def seed_regen_bundle() -> dict | None:
    if SEED_REGEN_PATH.exists():
        return load_json(SEED_REGEN_PATH)
    return None


def complexity_rows_from_bundle(data: dict) -> list[tuple[int, float, float, float]]:
    rows = data.get("controlled_comparison", {}).get("rows", [])
    out: list[tuple[int, float, float, float]] = []
    for row in rows:
        size = int(row["size"])
        samples = row["samples"]["backtracking"]
        solved = [s["time_ms"] for s in samples if (not s["timed_out"]) and s["success"]]
        if not solved:
            continue
        best = min(solved)
        mean = sum(solved) / len(solved)
        worst = max(solved)
        out.append((size, best, mean, worst))
    return sorted(out, key=lambda item: item[0])


def solve_3x3(a: list[list[float]], b: list[float]) -> tuple[float, float, float]:
    m = [row[:] + [rhs] for row, rhs in zip(a, b)]
    for i in range(3):
        pivot = i
        for r in range(i + 1, 3):
            if abs(m[r][i]) > abs(m[pivot][i]):
                pivot = r
        m[i], m[pivot] = m[pivot], m[i]
        div = m[i][i]
        if abs(div) < 1e-12:
            return (0.0, 0.0, 0.0)
        for c in range(i, 4):
            m[i][c] /= div
        for r in range(3):
            if r == i:
                continue
            factor = m[r][i]
            for c in range(i, 4):
                m[r][c] -= factor * m[i][c]
    return (m[0][3], m[1][3], m[2][3])


def fit_theta_cubic(size_values: list[int], time_values: list[float]) -> tuple[float, float, float]:
    s22 = s23 = s2 = s33 = s3 = 0.0
    y2 = y3 = y1 = 0.0
    n = len(size_values)
    for g, t in zip(size_values, time_values):
        g2 = float(g * g)
        g3 = g2 * float(g)
        s22 += g2 * g2
        s23 += g2 * g3
        s2 += g2
        s33 += g3 * g3
        s3 += g3
        y2 += g2 * t
        y3 += g3 * t
        y1 += t
    a = [[s22, s23, s2], [s23, s33, s3], [s2, s3, float(n)]]
    b = [y2, y3, y1]
    return solve_3x3(a, b)


def ensure_dir() -> None:
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)


def font_candidates(bold: bool) -> list[str]:
    if bold:
        return [
            "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
            "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf",
        ]
    return [
        "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
        "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]


def get_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in font_candidates(bold):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


TITLE_FONT = get_font(50, bold=True)
SUBTITLE_FONT = get_font(28)
LABEL_FONT = get_font(32)
TICK_FONT = get_font(26)
LEGEND_FONT = get_font(28)
ANNOTATION_FONT = get_font(24, bold=True)
SMALL_FONT = get_font(24)


def canvas():
    image = Image.new("RGBA", (WIDTH, HEIGHT), BG)
    return image, ImageDraw.Draw(image)


def chart_bounds():
    return MARGIN_LEFT, MARGIN_TOP, WIDTH - MARGIN_RIGHT, HEIGHT - MARGIN_BOTTOM


def text_size(draw: ImageDraw.ImageDraw, text: str, font) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


def draw_text_center(draw: ImageDraw.ImageDraw, xy: tuple[float, float], text: str, font, fill=TEXT):
    w, h = text_size(draw, text, font)
    draw.text((xy[0] - w / 2, xy[1] - h / 2), text, font=font, fill=fill)


def draw_title(draw: ImageDraw.ImageDraw, title: str, subtitle: str | None = None):
    draw.text((MARGIN_LEFT, 20), title, font=TITLE_FONT, fill=TEXT)
    if subtitle:
        draw.text((MARGIN_LEFT, 86), subtitle, font=SUBTITLE_FONT, fill=MUTED)


def draw_axes(image: Image.Image, draw: ImageDraw.ImageDraw, x_label: str, y_label: str):
    left, top, right, bottom = chart_bounds()
    draw.line((left, bottom, right, bottom), fill=AXIS, width=4)
    draw.line((left, top, left, bottom), fill=AXIS, width=4)
    draw_text_center(draw, ((left + right) / 2, HEIGHT - 42), x_label, LABEL_FONT)
    draw.text((left + 10, top + 10), y_label, font=LABEL_FONT, fill=MUTED)


def format_value(value: float) -> str:
    if value >= 100:
        return f"{value:.0f}"
    if value >= 10:
        return f"{value:.1f}"
    return f"{value:.2f}"


def linear_ticks(max_value: float, count: int = 5) -> list[float]:
    if max_value <= 0:
        return [0, 1]
    raw_step = max_value / count
    magnitude = 10 ** math.floor(math.log10(raw_step))
    normalized = raw_step / magnitude
    if normalized <= 1:
        nice_norm = 1
    elif normalized <= 2:
        nice_norm = 2
    elif normalized <= 2.5:
        nice_norm = 2.5
    elif normalized <= 5:
        nice_norm = 5
    else:
        nice_norm = 10
    step = nice_norm * magnitude
    tick_max = math.ceil(max_value / step) * step
    n_ticks = int(round(tick_max / step))
    return [step * i for i in range(n_ticks + 1)]


def log_ticks(min_value: float, max_value: float) -> list[float]:
    lo = int(math.floor(math.log10(max(min_value, 1e-6))))
    hi = int(math.ceil(math.log10(max_value)))
    return [10 ** e for e in range(lo, hi + 1)]


def map_y(value: float, y_min: float, y_max: float, *, log_scale: bool) -> float:
    left, top, right, bottom = chart_bounds()
    if log_scale:
        value = max(value, y_min)
        ly = math.log10(value)
        lmin = math.log10(y_min)
        lmax = math.log10(y_max)
        return bottom - (ly - lmin) * (bottom - top) / (lmax - lmin)
    return bottom - (value - y_min) * (bottom - top) / (y_max - y_min)


def draw_y_grid(draw: ImageDraw.ImageDraw, ticks: list[float], y_min: float, y_max: float, *, log_scale: bool):
    left, top, right, bottom = chart_bounds()

    def format_tick_label(tick: float) -> str:
        if log_scale:
            if tick >= 1000:
                return f"{int(tick):,}"
            if tick >= 10 or float(tick).is_integer():
                return f"{int(tick)}"
            return f"{tick:g}"
        # Linear scale labels should be explicit and easy to scan in print/PDF.
        if abs(tick) >= 1000:
            return f"{int(round(tick)):,}"
        if float(tick).is_integer():
            return f"{int(tick)}"
        return f"{tick:g}"

    for tick in ticks:
        y = map_y(tick, y_min, y_max, log_scale=log_scale)
        draw.line((left, y, right, y), fill=GRID, width=2)
        # Draw a small axis notch so labels visually connect to the y-axis.
        draw.line((left - 8, y, left, y), fill=AXIS, width=2)
        label = format_tick_label(tick)
        w, h = text_size(draw, label, TICK_FONT)
        draw.text((left - 20 - w, y - h / 2), label, font=TICK_FONT, fill=AXIS)


def draw_x_labels(draw: ImageDraw.ImageDraw, labels: list[str], centers: list[float]):
    _, _, _, bottom = chart_bounds()
    for label, x in zip(labels, centers):
        w, _ = text_size(draw, label, TICK_FONT)
        draw.text((x - w / 2, bottom + 18), label, font=TICK_FONT, fill=TEXT)


def draw_legend(draw: ImageDraw.ImageDraw, items: list[tuple[str, str]]):
    _, top, right, _ = chart_bounds()
    x = right - 380
    y = top - 68
    for i, (label, color) in enumerate(items):
        y0 = y + i * 40
        draw.rounded_rectangle((x, y0 + 6, x + 28, y0 + 26), radius=5, fill=color, outline=color)
        draw.text((x + 40, y0 - 2), label, font=LEGEND_FONT, fill=TEXT)


def boxes_overlap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def place_callout(
    draw: ImageDraw.ImageDraw,
    anchor_x: float,
    anchor_y: float,
    text: str,
    existing_boxes: list[tuple[float, float, float, float]],
    *,
    preferred_dx: float = 16,
    preferred_dy: float = -10,
) -> tuple[float, float, tuple[float, float, float, float]]:
    left, top, right, bottom = chart_bounds()
    tw, th = text_size(draw, text, SMALL_FONT)
    pad_x, pad_y = 10, 6
    total_w = tw + 2 * pad_x
    total_h = th + 2 * pad_y

    # Try nearby quadrants first, then slight vertical offsets.
    candidates = [
        (anchor_x + preferred_dx, anchor_y + preferred_dy),
        (anchor_x - total_w - preferred_dx, anchor_y + preferred_dy),
        (anchor_x + preferred_dx, anchor_y + 16),
        (anchor_x - total_w - preferred_dx, anchor_y + 16),
        (anchor_x - total_w / 2, anchor_y - total_h - 16),
        (anchor_x - total_w / 2, anchor_y + 16),
    ]
    for shift in range(1, 5):
        candidates.append((anchor_x + preferred_dx, anchor_y + preferred_dy + shift * 24))
        candidates.append((anchor_x - total_w - preferred_dx, anchor_y + preferred_dy + shift * 24))

    for x, y in candidates:
        x = max(left + 8, min(x, right - total_w - 8))
        y = max(top + total_h + 8, min(y, bottom - 8))
        box = (x, y - total_h, x + total_w, y)
        if not any(boxes_overlap(box, used) for used in existing_boxes):
            return x + pad_x, y - pad_y, box

    x = max(left + 8, min(anchor_x + preferred_dx, right - total_w - 8))
    y = max(top + total_h + 8, min(anchor_y + preferred_dy, bottom - 8))
    box = (x, y - total_h, x + total_w, y)
    return x + pad_x, y - pad_y, box


def draw_callout(draw: ImageDraw.ImageDraw, x: float, y: float, text: str, color: str):
    _, h = text_size(draw, text, SMALL_FONT)
    draw.text(
        (x, y - h - 4),
        text,
        font=SMALL_FONT,
        fill=color,
        stroke_width=2,
        stroke_fill="#ffffff",
    )


def draw_error_bar(
    draw: ImageDraw.ImageDraw,
    x: float,
    low: float,
    high: float,
    y_min: float,
    y_max: float,
    *,
    log_scale: bool,
    color: str,
):
    cap = 14
    y_low = map_y(low, y_min, y_max, log_scale=log_scale)
    y_high = map_y(high, y_min, y_max, log_scale=log_scale)
    draw.line((x, y_low, x, y_high), fill=color, width=3)
    draw.line((x - cap, y_low, x + cap, y_low), fill=color, width=3)
    draw.line((x - cap, y_high, x + cap, y_high), fill=color, width=3)


def grouped_bar_chart(filename: str, title: str, subtitle: str, labels: list[str], series: list[tuple], y_label: str, *, x_label: str = "Chunk size", log_scale: bool = False, y_min: float | None = None, target_line: tuple[float, str, str] | None = None):
    image, draw = canvas()
    draw_title(draw, title, subtitle)
    draw_axes(image, draw, x_label, y_label)
    left, top, right, bottom = chart_bounds()

    all_values = []
    for item in series:
        _, values, _, *rest = item
        all_values.extend(values)
        if len(rest) >= 2:
            all_values.extend(rest[1])
    y_min = y_min if y_min is not None else (1 if log_scale else 0)
    y_max = max(all_values) * (1.35 if not log_scale else 1.6)
    ticks = log_ticks(y_min, y_max) if log_scale else linear_ticks(y_max)
    draw_y_grid(draw, ticks, y_min, y_max, log_scale=log_scale)

    group_width = (right - left) / len(labels)
    inner_width = group_width * 0.68
    bar_width = inner_width / len(series)
    centers = []

    used_callout_boxes: list[tuple[float, float, float, float]] = []
    if target_line:
        y_value, label, color = target_line
        y = map_y(y_value, y_min, y_max, log_scale=log_scale)
        draw.line((left, y, right, y), fill=color, width=4)
        tx, ty, box = place_callout(draw, right - 20, y, label, used_callout_boxes, preferred_dx=-220, preferred_dy=-14)
        used_callout_boxes.append(box)
        draw_callout(draw, tx, ty, label, color)

    for index, label in enumerate(labels):
        group_center = left + group_width * (index + 0.5)
        centers.append(group_center)
        start_x = group_center - inner_width / 2
        for s_idx, item in enumerate(series):
            name, values, color, *rest = item
            value = values[index]
            x0 = start_x + s_idx * bar_width
            x1 = x0 + bar_width * 0.84
            y1 = map_y(value, y_min, y_max, log_scale=log_scale)
            y0 = map_y(y_min, y_min, y_max, log_scale=log_scale)
            draw.rounded_rectangle((x0, y1, x1, y0), radius=10, fill=color, outline=color)
            if len(rest) >= 2:
                lows = rest[0]
                highs = rest[1]
                draw_error_bar(
                    draw,
                    (x0 + x1) / 2,
                    max(lows[index], y_min),
                    max(highs[index], y_min),
                    y_min,
                    y_max,
                    log_scale=log_scale,
                    color="#1f2937",
                )
            val_text = format_value(value)
            tx, ty, box = place_callout(draw, (x0 + x1) / 2, y1, val_text, used_callout_boxes)
            used_callout_boxes.append(box)
            draw_callout(draw, tx, ty, val_text, color)

    draw_x_labels(draw, labels, centers)
    draw_legend(draw, [(item[0], item[2]) for item in series])
    image.convert("RGB").save(FIGURES_DIR / filename)


def line_chart(filename: str, title: str, subtitle: str, labels: list[str], series: list[tuple], y_label: str, *, x_label: str = "Chunk size", log_scale: bool = False, y_min: float | None = None, target_line: tuple[float, str, str] | None = None, label_mode: str = "all"):
    image, draw = canvas()
    draw_title(draw, title, subtitle)
    draw_axes(image, draw, x_label, y_label)
    left, top, right, bottom = chart_bounds()

    all_values = []
    for item in series:
        _, values, _, *rest = item
        all_values.extend(values)
        if len(rest) >= 2:
            all_values.extend(rest[1])
    y_min = y_min if y_min is not None else (1 if log_scale else 0)
    y_max = max(all_values) * (1.35 if not log_scale else 1.6)
    ticks = log_ticks(y_min, y_max) if log_scale else linear_ticks(y_max)
    draw_y_grid(draw, ticks, y_min, y_max, log_scale=log_scale)

    x_positions = []
    step = (right - left) / max(1, len(labels) - 1)
    for i in range(len(labels)):
        x = left + i * step
        x_positions.append(x)
        draw.line((x, top, x, bottom), fill="#edf0f4", width=1)

    used_callout_boxes: list[tuple[float, float, float, float]] = []
    if target_line:
        y_value, label, color = target_line
        y = map_y(y_value, y_min, y_max, log_scale=log_scale)
        draw.line((left, y, right, y), fill=color, width=4)
        tx, ty, box = place_callout(draw, right - 20, y, label, used_callout_boxes, preferred_dx=-220, preferred_dy=-14)
        used_callout_boxes.append(box)
        draw_callout(draw, tx, ty, label, color)

    for item in series:
        name, values, color, *rest = item
        lows = rest[0] if len(rest) >= 2 else None
        highs = rest[1] if len(rest) >= 2 else None
        points = [(x_positions[i], map_y(v, y_min, y_max, log_scale=log_scale)) for i, v in enumerate(values)]
        if lows is not None and highs is not None:
            for i in range(len(values)):
                draw_error_bar(
                    draw,
                    x_positions[i],
                    max(lows[i], y_min),
                    max(highs[i], y_min),
                    y_min,
                    y_max,
                    log_scale=log_scale,
                    color=color,
                )
        draw.line(points, fill=color, width=6)
        if label_mode == "last":
            label_indices = [len(points) - 1]
        elif label_mode == "none":
            label_indices = []
        else:
            label_indices = list(range(len(points)))

        for i, (x, y) in enumerate(points):
            draw.ellipse((x - 8, y - 8, x + 8, y + 8), fill=color, outline="#ffffff", width=2)
            if i in label_indices:
                tx, ty, box = place_callout(draw, x, y, format_value(values[i]), used_callout_boxes)
                used_callout_boxes.append(box)
                draw_callout(draw, tx, ty, format_value(values[i]), color)

    draw_x_labels(draw, labels, x_positions)
    draw_legend(draw, [(item[0], item[2]) for item in series])
    image.convert("RGB").save(FIGURES_DIR / filename)


def point_line_chart(filename: str, title: str, subtitle: str, x_values: list[int], y_values: list[float], x_label: str, y_label: str, *, live_point: tuple[int, float, str, str] | None = None, target_line: tuple[float, str, str] | None = None):
    image, draw = canvas()
    draw_title(draw, title, subtitle)
    draw_axes(image, draw, x_label, y_label)
    left, top, right, bottom = chart_bounds()
    y_min, y_max = 1, max(max(y_values), live_point[1] if live_point else 0, 16) * 1.5
    draw_y_grid(draw, log_ticks(y_min, y_max), y_min, y_max, log_scale=True)

    x_min, x_max = min(x_values), max(x_values)

    def map_x(x: int) -> float:
        if x_max == x_min:
            return (left + right) / 2
        return left + (x - x_min) * (right - left) / (x_max - x_min)

    for x in x_values:
        px = map_x(x)
        draw.line((px, top, px, bottom), fill="#edf0f4", width=1)
        label = f"{int(math.sqrt(x))}×{int(math.sqrt(x))}"
        w, _ = text_size(draw, label, TICK_FONT)
        draw.text((px - w / 2, bottom + 18), label, font=TICK_FONT, fill=TEXT)

    used_callout_boxes: list[tuple[float, float, float, float]] = []
    if target_line:
        y_value, label, color = target_line
        y = map_y(y_value, y_min, y_max, log_scale=True)
        draw.line((left, y, right, y), fill=color, width=4)
        tx, ty, box = place_callout(draw, right - 20, y, label, used_callout_boxes, preferred_dx=-220, preferred_dy=-14)
        used_callout_boxes.append(box)
        draw_callout(draw, tx, ty, label, color)

    points = [(map_x(x), map_y(y, y_min, y_max, log_scale=True)) for x, y in zip(x_values, y_values)]
    draw.line(points, fill=BT, width=6)
    for x, y, value in zip(x_values, points, y_values):
        px, py = y
        draw.ellipse((px - 8, py - 8, px + 8, py + 8), fill=BT, outline="#ffffff", width=2)
        tx, ty, box = place_callout(draw, px, py, f"{format_value(value)} ms", used_callout_boxes)
        used_callout_boxes.append(box)
        draw_callout(draw, tx, ty, f"{format_value(value)} ms", BT)

    if live_point:
        x, y, label, color = live_point
        px = map_x(x)
        py = map_y(y, y_min, y_max, log_scale=True)
        draw.ellipse((px - 11, py - 11, px + 11, py + 11), fill=color, outline="#ffffff", width=3)
        tx, ty, box = place_callout(draw, px, py, label, used_callout_boxes)
        used_callout_boxes.append(box)
        draw_callout(draw, tx, ty, label, color)

    draw_legend(draw, [("Controlled backtracking mean", BT), ("Live configuration", TEAL)])
    image.convert("RGB").save(FIGURES_DIR / filename)


def bar_chart(filename: str, title: str, subtitle: str, labels: list[str], values: list[float], colors: list[str], y_label: str, *, x_label: str = "Metric", target_line: tuple[float, str, str] | None = None, log_scale: bool = False, y_min: float | None = None):
    image, draw = canvas()
    draw_title(draw, title, subtitle)
    draw_axes(image, draw, x_label, y_label)
    left, top, right, bottom = chart_bounds()
    if log_scale:
        y_min = y_min if y_min is not None else 0.01
        y_max = max(max(values), y_min) * 1.35
        ticks = log_ticks(y_min, y_max)
        draw_y_grid(draw, ticks, y_min, y_max, log_scale=True)
    else:
        y_min = y_min if y_min is not None else 0
        y_max = max(values) * 1.35
        ticks = linear_ticks(y_max)
        draw_y_grid(draw, ticks, y_min, y_max, log_scale=False)

    step = (right - left) / len(labels)
    centers = []

    used_callout_boxes: list[tuple[float, float, float, float]] = []
    if target_line:
        y_value, label, color = target_line
        y = map_y(y_value, y_min, y_max, log_scale=log_scale)
        draw.line((left, y, right, y), fill=color, width=4)
        tx, ty, box = place_callout(draw, left + 30, y, label, used_callout_boxes, preferred_dx=20, preferred_dy=-14)
        used_callout_boxes.append(box)
        draw_callout(draw, tx, ty, label, color)

    for i, (label, value, color) in enumerate(zip(labels, values, colors)):
        center = left + step * (i + 0.5)
        centers.append(center)
        bar_width = step * 0.5
        x0 = center - bar_width / 2
        x1 = center + bar_width / 2
        bar_value = max(value, y_min) if log_scale else value
        y1 = map_y(bar_value, y_min, y_max, log_scale=log_scale)
        draw.rounded_rectangle((x0, y1, x1, bottom), radius=12, fill=color, outline=color)
        tx, ty, box = place_callout(draw, center, y1, format_value(value), used_callout_boxes)
        used_callout_boxes.append(box)
        draw_callout(draw, tx, ty, format_value(value), color)

    draw_x_labels(draw, labels, centers)
    image.save(FIGURES_DIR / filename)


def save_figures():
    ensure_dir()
    b = bundle()
    b10, b20 = bundle_pair()
    e = endurance()
    cb = complexity_bundle()
    seed_regen = seed_regen_bundle()

    controlled_10 = b10["controlled_comparison"]["rows"][0]
    controlled_20 = b20["controlled_comparison"]["rows"][0]
    compare_sizes = ["10×10", "20×20"]
    bt_times = [
        controlled_10["backtracking"]["time_ms"]["mean"],
        controlled_20["backtracking"]["time_ms"]["mean"],
    ]
    bt_std = [
        controlled_10["backtracking"]["time_ms"]["std_dev"],
        controlled_20["backtracking"]["time_ms"]["std_dev"],
    ]
    restart_times = [
        controlled_10["restart"]["time_ms"]["mean"],
        controlled_20["restart"]["time_ms"]["mean"],
    ]
    restart_std = [
        controlled_10["restart"]["time_ms"]["std_dev"],
        controlled_20["restart"]["time_ms"]["std_dev"],
    ]
    bt_low = [max(0.01, m - s) for m, s in zip(bt_times, bt_std)]
    bt_high = [m + s for m, s in zip(bt_times, bt_std)]
    restart_low = [max(0.01, m - s) for m, s in zip(restart_times, restart_std)]
    restart_high = [m + s for m, s in zip(restart_times, restart_std)]
    bt_attempts = [
        controlled_10["backtracking"]["attempts"]["mean"],
        controlled_20["backtracking"]["attempts"]["mean"],
    ]
    restart_attempts = [
        controlled_10["restart"]["attempts"]["mean"],
        controlled_20["restart"]["attempts"]["mean"],
    ]
    bt_backtracks = [
        controlled_10["backtracking"]["backtracks"]["mean"],
        controlled_20["backtracking"]["backtracks"]["mean"],
    ]
    speedup = [
        restart_times[0] / bt_times[0],
        restart_times[1] / bt_times[1],
    ]

    halo_10 = b10["halo_ablation"]["rows"][0]
    halo_20 = b20["halo_ablation"]["rows"][0]
    halo_sizes = ["10×10", "20×20"]
    halo0_times = [halo_10["halo_0"]["time_ms"]["mean"], halo_20["halo_0"]["time_ms"]["mean"]]
    halo2_times = [halo_10["halo_2"]["time_ms"]["mean"], halo_20["halo_2"]["time_ms"]["mean"]]

    stream_10 = b10["streaming_scenarios"]["rows"][0]
    stream_20 = b20["streaming_scenarios"]["rows"][0]
    streaming_sizes = ["10×10", "20×20"]
    streaming_times = [stream_10["avg_generation_time_ms"], stream_20["avg_generation_time_ms"]]

    size_cells = [100, 400]

    live_chunk_size = e["demo_config"]["chunk_size"]
    live_cells = live_chunk_size * live_chunk_size
    live_mean = e["empirical_time"]["avg_generation_time_ms"]
    live_p95 = e["empirical_time"]["p95_generation_time_ms"]
    live_max = e["empirical_time"]["max_generation_time_ms"]

    generated_chunks = e["empirical_time"]["generated_chunks"]
    chunk_area = live_chunk_size ** 2
    cache_limit = e["demo_config"]["cache_limit"]
    x_values = list(range(1, generated_chunks + 1))
    active_tiles = [min(cache_limit, n) * chunk_area for n in x_values]
    persistent_tiles = [n * chunk_area for n in x_values]
    peak_memory_chunks = e["empirical_memory"]["peak_memory_chunks"]
    local_storage_entries = e["empirical_memory"]["local_storage_entries"]

    line_chart(
        "fig_attempt_count_comparison.png",
        "Attempt cost across evaluated chunk sizes",
        "Restart pays an attempt overhead while backtracking remains near one attempt",
        compare_sizes,
        [
            ("Backtracking attempts", bt_attempts, BT),
            ("Restart attempts", restart_attempts, RESTART),
        ],
        "Attempts per solve",
        x_label="Chunk size",
        log_scale=False,
    )

    bar_chart(
        "fig_backtrack_depth.png",
        "Backtracking search effort",
        "Mean backtrack count in controlled 10×10 and 20×20 benchmarks",
        compare_sizes,
        bt_backtracks,
        [BT, BT],
        "Mean backtracks (log)",
        x_label="Chunk size",
        log_scale=True,
        y_min=0.01,
    )

    line_chart(
        "fig_streaming_timing_growth.png",
        "Streaming generation-time gate",
        "20×20 exceeds the 16 ms target, so further scaling is stopped",
        streaming_sizes,
        [("Streaming mean", streaming_times, RESTART)],
        "Generation time (ms, log)",
        log_scale=True,
        y_min=1,
        target_line=(16, "16 ms target", BUDGET),
    )

    line_chart(
        "fig_space_complexity_profile.png",
        "Space-complexity profile for the live configuration",
        "Active memory remains bounded while persistent storage grows with explored world size",
        [str(n) for n in [1, 250, 500, 750, 1000]],
        [
            (
                "Active-memory upper bound",
                [active_tiles[n - 1] for n in [1, 250, 500, 750, 1000]],
                RESTART,
            ),
            (
                "Persistent storage growth",
                [persistent_tiles[n - 1] for n in [1, 250, 500, 750, 1000]],
                TEAL,
            ),
        ],
        "Stored tile cells",
        x_label="Generated chunks N",
        log_scale=False,
        label_mode="last",
    )

    bar_chart(
        "fig_endurance_latency_profile.png",
        "Latency profile for the selected live configuration (10×10, backtracking-only)",
        "1000-chunk endurance run: mean, p95, and max latency for the final 10×10 live setup",
        ["Mean", "P95", "Max"],
        [live_mean, live_p95, live_max],
        [TEAL, RESTART, GOLD],
        "Generation time (ms)",
    )

    if seed_regen:
        summary = seed_regen.get("summary", {})
        checks_total = int(summary.get("deterministic_checks_total", 0))
        checks_passed = int(summary.get("deterministic_checks_passed", 0))
        checks_failed = max(0, checks_total - checks_passed)
        recompute = summary.get("recompute_time_ms", {})
        tradeoff = summary.get("space_tradeoff", {})

        bar_chart(
            "fig_seed_regen_determinism.png",
            "Seed-regeneration determinism audit",
            "Replay with coordinate seed and original boundary snapshot over sampled checkpoints",
            ["Passed", "Failed"],
            [checks_passed, checks_failed],
            [TEAL, BUDGET],
            "Checkpoint count",
            x_label="Determinism result",
            log_scale=False,
        )

        bar_chart(
            "fig_seed_regen_recompute_profile.png",
            "Seed-regeneration recompute time profile",
            "Per-checkpoint replay solve cost under seed-only revisit strategy",
            ["Mean", "P95", "Max"],
            [
                float(recompute.get("mean", 0.0)),
                float(recompute.get("p95", 0.0)),
                float(recompute.get("max", 0.0)),
            ],
            [TEAL, RESTART, GOLD],
            "Replay solve time (ms)",
            x_label="Latency metric",
            log_scale=False,
        )

        bar_chart(
            "fig_seed_regen_space_tradeoff.png",
            "Space-time tradeoff: full persistence vs seed-only metadata",
            "Storage footprint comparison for N=1000 chunks",
            ["Full grids (tile cells)", "Seed-only (scalar units)"],
            [
                float(tradeoff.get("persistent_storage_tile_cells", 0.0)),
                float(tradeoff.get("seed_only_scalar_units_estimate", 0.0)),
            ],
            [RESTART, TEAL],
            "Stored units (log scale)",
            x_label="Persistence strategy",
            log_scale=True,
            y_min=1,
        )

    if cb:
        complexity_rows = complexity_rows_from_bundle(cb)
        if len(complexity_rows) >= 3:
            sizes = [size for size, _, _, _ in complexity_rows]
            best_measured = [value for _, value, _, _ in complexity_rows]
            measured = [value for _, _, value, _ in complexity_rows]
            worst_measured = [value for _, _, _, value in complexity_rows]
            labels = [f"{g}×{g}" for g in sizes]
            g2 = [float(g * g) for g in sizes]

            # Scaled O(G^2) reference curve for worst-case trend (least-squares through origin).
            denom = sum(v * v for v in g2)
            k2 = (sum(v * t for v, t in zip(g2, worst_measured)) / denom) if denom > 0 else 0.0
            o2_ref = [k2 * v for v in g2]

            # Scaled Omega(G^2) reference for best-case trend.
            k_omega = min((t / v) for t, v in zip(best_measured, g2) if v > 0) if g2 else 0.0
            omega_ref = [k_omega * v for v in g2]

            # Empirical Theta-fit for average-case behaviour: aG^2 + bG^3 + c.
            a2, b3, c0 = fit_theta_cubic(sizes, measured)
            theta_fit = [a2 * (g * g) + b3 * (g * g * g) + c0 for g in sizes]

            line_chart(
                "fig_time_complexity_validation.png",
                "Measured vs theoretical time-complexity curves",
                "Average-case runtime compared with O(G²), fitted Θ model, and Ω(G²) reference",
                labels,
                [
                    ("Measured average", measured, TEAL),
                    ("Scaled O(G²) reference", o2_ref, RESTART),
                    ("Fitted Θ average model", theta_fit, BT),
                    ("Scaled Ω(G²) reference", omega_ref, GOLD),
                ],
                "Solve time (ms)",
                x_label="Chunk size",
                log_scale=False,
                label_mode="none",
            )

            line_chart(
                "fig_sigma_complexity_validation.png",
                "Best/Average/Worst complexity comparison",
                "Empirical best, average, and worst solve times versus Ω/Θ/O growth references",
                labels,
                [
                    ("Empirical best case", best_measured, GOLD),
                    ("Empirical average case", measured, TEAL),
                    ("Empirical worst case", worst_measured, RESTART),
                    ("Ω(G²) reference", omega_ref, "#8f7a4f"),
                    ("Θ fit (average)", theta_fit, BT),
                    ("O(G²) reference", o2_ref, SLATE),
                ],
                "Solve time (ms)",
                x_label="Chunk size",
                log_scale=False,
                label_mode="none",
            )


if __name__ == "__main__":
    save_figures()
