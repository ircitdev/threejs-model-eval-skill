# threejs-model-eval

Скилл для Claude Code: тестирует локальные LLM, которые пишут 3D-сцены на Three.js. Модель из GGUF запускается через Ollama, генерирует сцены по набору промптов, а результат проверяется запуском в изолированном headless Chrome.

Что проверяется:

- дошла ли генерация до готового HTML, с защитой от зацикливания модели;
- запускается ли сцена без ошибок и не пуст ли экран;
- работают ли камера, ходьба и кнопки, по координатам камеры, а не по сравнению скриншотов;
- остаётся ли камера внутри помещения в интерьерных сценах.

Итог — таблица `report.md` и скриншоты каждой сцены.

## Установка

```bash
git clone https://github.com/ircitdev/threejs-model-eval-skill ~/.claude/skills/threejs-model-eval
```

Нужны Ollama, Python 3.10+, Node.js 20+ и Chrome. Видеокарта с памятью больше размера GGUF заметно ускоряет работу.

## Запуск без Claude

```bash
python scripts/generate.py --model my-model --out out --seeds 42,43
npm i playwright-core
node scripts/check_scene.mjs --dir out
python scripts/report.py --dir out
```

`check_scene.mjs` запускайте из папки, где установлен `playwright-core`.

Порядок работы и правила интерпретации результатов описаны в [SKILL.md](SKILL.md).
