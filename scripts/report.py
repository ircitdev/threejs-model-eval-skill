#!/usr/bin/env python3
"""Сводит generate.jsonl и check.jsonl в таблицу report.md."""
import argparse
import json
import pathlib
import re
import sys


def load(path):
    if not path.exists():
        return {}
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    return {r["name"]: r for r in rows}  # при повторном прогоне действует последняя запись


def walk_text(walk):
    if not walk:
        return "—"
    if walk.get("moved") is None:
        return "не проверено"
    if not walk["moved"]:
        return "не двигается"
    inside = walk.get("stayed_inside")
    span = " × ".join(str(v) for v in walk["span"])
    if inside is None:
        return f"ходит, охват {span}"
    return f"внутри, охват {span}" if inside else f"вышла за стены, охват {span}"


def button_text(button):
    if not button:
        return "—"
    if not button.get("found"):
        return "не найдена"
    if not button.get("clicked"):
        return "не нажимается"
    return f"яркость {button['luma_before']} → {button['luma_after']}"


def run_text(gen, chk):
    if chk:
        return chk["verdict"]
    return "не проверялась" if gen and gen["status"] == "ok" else "—"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dir", required=True, type=pathlib.Path)
    args = p.parse_args()

    generated = load(args.dir / "generate.jsonl")
    checked = load(args.dir / "check.jsonl")
    lines = [
        "| Сцена | Время, с | Токены | ток/с | Генерация | Запуск | Камера | Ходьба | Кнопка | Ошибка |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for name in sorted(set(generated) | set(checked)):
        g, c = generated.get(name), checked.get(name)
        error = (c.get("harness_error") or (c["errors"][0] if c["errors"] else "")) if c else ""
        error = error.replace("|", "\\|")
        lines.append(
            "| " + " | ".join(str(v) for v in [
                name,
                g["wall_s"] if g else "—",
                g["tokens"] if g else "—",
                g["tok_per_s"] if g and g["tok_per_s"] else "—",
                g["status"] if g else "правка" if name.endswith("-fixed") else "—",
                run_text(g, c),
                (c.get("orbit") or "—") if c else "—",
                walk_text(c.get("walk")) if c else "—",
                button_text(c.get("button")) if c else "—",
                error or "—",
            ]) + " |"
        )

    originals = [n for n in generated if not re.search(r"-fixed$", n)]
    first_try = sum(1 for n in originals if checked.get(n, {}).get("verdict") == "runs")
    with_html = sum(1 for n in originals if generated[n]["status"] == "ok")
    unchecked = sum(1 for n in originals if generated[n]["status"] == "ok" and n not in checked)
    summary = [
        f"Запустились с первой попытки: **{first_try} из {len(originals)}**. HTML получен: {with_html} из {len(originals)}.",
    ]
    if unchecked:
        summary.append(f"Не проверено в браузере: {unchecked}.")
    text = "# Отчёт о тесте\n\n" + " ".join(summary) + "\n\n" + "\n".join(lines) + "\n"
    (args.dir / "report.md").write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
