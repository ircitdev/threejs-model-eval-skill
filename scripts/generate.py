#!/usr/bin/env python3
"""Генерирует сцены через Ollama в raw-режиме и сохраняет HTML, сырой вывод и статистику."""
import argparse
import json
import pathlib
import re
import sys
import time
import urllib.request

DEFAULT_PROMPTS = pathlib.Path(__file__).resolve().parent.parent / "assets" / "prompts.json"
CHATML = "<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n"
THINK_OPEN = "<think>\n"
THINK_EMPTY = "<think>\n\n</think>\n\n"

LOOP_BLOCK = 300
LOOP_WINDOW = 40000
LOOP_REPEATS = 8
LOOP_CHECK_EVERY = 2000


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", required=True)
    p.add_argument("--out", required=True, type=pathlib.Path)
    p.add_argument("--prompts", type=pathlib.Path, default=DEFAULT_PROMPTS)
    p.add_argument("--only", help="имена промптов через запятую")
    p.add_argument("--seeds", default="42", help="seed через запятую")
    p.add_argument("--host", default="http://127.0.0.1:11434")
    p.add_argument("--template-file", type=pathlib.Path, help="шаблон с полями {system} и {user}")
    p.add_argument("--no-think", action="store_true", help="сразу закрыть блок рассуждений")
    p.add_argument("--num-predict", type=int, default=32000)
    p.add_argument("--num-ctx", type=int, default=32768)
    p.add_argument("--temperature", type=float, default=0.7)
    p.add_argument("--top-p", type=float, default=0.95)
    p.add_argument("--top-k", type=int, default=30)
    p.add_argument("--repeat-penalty", type=float, default=1.0)
    p.add_argument("--stop", action="append", help="стоп-строка, можно указать несколько раз")
    p.add_argument("--timeout", type=int, default=1800, help="секунд ожидания ответа")
    return p.parse_args()


def is_looping(text):
    if len(text) < LOOP_BLOCK * LOOP_REPEATS:
        return False
    return text[-LOOP_WINDOW:].count(text[-LOOP_BLOCK:]) >= LOOP_REPEATS


def extract_html(text, thinking):
    if "</think>" in text:
        answer = text.split("</think>", 1)[1]
    elif thinking:
        return None
    else:
        answer = text
    fenced = re.search(r"```html\s*(.*?)```", answer, re.S | re.I)
    if fenced:
        return fenced.group(1).strip()
    bare = re.search(r"<!doctype html.*</html>", answer, re.S | re.I)
    return bare.group(0).strip() if bare else None


def stream(opener, args, prompt, seed):
    body = {
        "model": args.model,
        "prompt": prompt,
        "raw": True,
        "stream": True,
        "options": {
            "temperature": args.temperature,
            "top_p": args.top_p,
            "top_k": args.top_k,
            "repeat_penalty": args.repeat_penalty,
            "seed": seed,
            "num_ctx": args.num_ctx,
            "num_predict": args.num_predict,
            "stop": args.stop or ["<|im_end|>"],
        },
    }
    req = urllib.request.Request(
        args.host.rstrip("/") + "/api/generate",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    parts, length, next_check, chunks = [], 0, LOOP_CHECK_EVERY, 0
    with opener.open(req, timeout=args.timeout) as response:
        for line in response:
            d = json.loads(line)
            piece = d.get("response", "")
            if piece:
                parts.append(piece)
                length += len(piece)
                chunks += 1
            if d.get("done"):
                return "".join(parts), d, chunks
            if length >= next_check:
                next_check = length + LOOP_CHECK_EVERY
                text = "".join(parts)
                parts = [text]
                if is_looping(text):
                    return text, {"done_reason": "loop"}, chunks
    return "".join(parts), {"done_reason": "connection_closed"}, chunks


def status_of(done_reason, html):
    if html:
        return "ok"
    return {"loop": "loop", "length": "truncated"}.get(done_reason, "no_html")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args()
    suite = json.loads(args.prompts.read_text(encoding="utf-8"))
    only = set(args.only.split(",")) if args.only else None
    prompts = [p for p in suite["prompts"] if not only or p["name"] in only]
    if only and len(prompts) != len(only):
        sys.exit(f"не найдены промпты: {only - {p['name'] for p in prompts}}")

    template = args.template_file.read_text(encoding="utf-8") if args.template_file else CHATML
    suffix = THINK_EMPTY if args.no_think else THINK_OPEN
    if args.template_file:
        suffix = ""
    thinking = not args.no_think and not args.template_file

    args.out.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    for item in prompts:
        for seed in (int(s) for s in args.seeds.split(",")):
            stem = f"{item['name']}.s{seed}"
            prompt = template.format(system=suite.get("system", ""), user=item["prompt"]) + suffix
            started = time.time()
            text, final, chunks = stream(opener, args, prompt, seed)
            (args.out / f"{stem}.raw.txt").write_text(text, encoding="utf-8")
            html = extract_html(text, thinking)
            if html:
                (args.out / f"{stem}.html").write_text(html, encoding="utf-8")
            duration = final.get("eval_duration")
            record = {
                "name": stem,
                "prompt": item["name"],
                "seed": seed,
                "model": args.model,
                "status": status_of(final.get("done_reason"), html),
                "done_reason": final.get("done_reason"),
                "wall_s": round(time.time() - started, 1),
                "tokens": final.get("eval_count", chunks),
                "tok_per_s": round(final["eval_count"] / (duration / 1e9), 1) if duration else None,
                "closed_think": "</think>" in text,
                "think_chars": len(text.split("</think>", 1)[0]) if "</think>" in text else len(text),
                "html_chars": len(html) if html else 0,
            }
            with (args.out / "generate.jsonl").open("a", encoding="utf-8") as log:
                log.write(json.dumps(record, ensure_ascii=False) + "\n")
            print(json.dumps(record, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
