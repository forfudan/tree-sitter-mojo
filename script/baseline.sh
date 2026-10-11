#!/usr/bin/env bash
# **這份語法能解析多少真實的 Mojo。**
#
# 靶是 Modular 自己的倉（`~/Programs/mojo`，Apache-2.0 with LLVM Exceptions）裏
# 的每一個 `.mojo`——三千多個，由寫這門語言的人寫的。一條規則補進去，這個數字當場
# 動；語法往前漂，這個數字當場掉。沒有別的東西盯得住這兩件事。
#
#     script/baseline.sh            # 兩行總數：真實 Mojo 與全語料
#     script/baseline.sh --why      # 再按出錯的那一行分類，看下一條該補什麼
#
# ---- 兩個數字，為什麼 --------------------------------------------------------
#
# 語料裏有一部分**根本不是 Mojo**，拿它們當分母只會把真實的進展壓扁。2026-10-11
# 逐個核過，排除兩類（下面 `EXCLUDE` 那幾條就是這兩類，按路徑形狀寫，不手列檔名）：
#
# 1. `mojo/tools/mblack/tests/data/` 底下的 117 個。`mojo/tools/mblack/` 是 Modular
#    對 **Black**（Python 的格式化工具）的分支，那個目錄是 Black 自己的 Python 測試
#    固件整批改了擴展名——`py_39/python39.mojo`、`pep_572_py39.mojo` 這一類。裏面用的
#    是 `class`／`match`-`case`／`yield`，**Mojo 自己的解析器一個都不實現**。
# 2. 參考解析器自己的負面測試：檔名收在 `errors.mojo`／`negative.mojo` 的那些，
#    **而且要在 `test/`／`tests/` 樹底下**。Modular 自己的解析器照設計拒收它們。
#    ⚠️ 那個「在測試樹底下」的限定不能省：`mojo/docs/site/code/manual/errors/`
#    底下有五個真 Mojo 檔也叫 `…errors.mojo`（手冊講錯誤處理的例子），把它們算成
#    負面測試就是白送五個檔。
#
# 兩個數字都印：**真實 Mojo 那一行是要驅的那個**，全語料那一行留着，好跟提交記錄裏
# 早先的數字對得上。
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
CORPUS=${MOJO_SRC:-$HOME/Programs/mojo}
[ -d "$CORPUS" ] || { echo "找不到語料：$CORPUS（用 MOJO_SRC= 指一個）" >&2; exit 2; }

cd "$HERE"
tree-sitter generate >/dev/null
all=$(mktemp); skip=$(mktemp); trap 'rm -f "$all" "$skip"' EXIT
find "$CORPUS" -name '*.mojo' -not -path '*/.*' | sort > "$all"
# 排除名單，按路徑形狀算出來。
{
  grep -E '/mojo/tools/mblack/tests/data/' "$all" || true
  grep -E '/(test|tests)/.*(errors|negative)\.mojo$' "$all" || true
} | sort -u > "$skip"

n_all=$(wc -l < "$all" | tr -d ' ')
n_skip=$(wc -l < "$skip" | tr -d ' ')
n_real=$((n_all - n_skip))
n_mblack=$(grep -cE '/mojo/tools/mblack/tests/data/' "$skip" || true)
n_neg=$((n_skip - n_mblack))
printf '語料：%s 個檔（%s）\n' "$n_all" "$CORPUS"
printf '排除 %s 個：mblack 的 Python 固件 %s、參考解析器的負面測試 %s → 真實 Mojo %s 個\n' \
  "$n_skip" "$n_mblack" "$n_neg" "$n_real"

# Warning: **`tree-sitter parse` 有一個檔沒過就以非零退出**，而這一支整個存在的
# 意義就是去數那些沒過的。`|| true` 不能省，否則 `set -e` 在第一輪就把腳本打斷，
# 印出來的只有語料那一行——寫完當場踩了一次。
out=$(xargs tree-sitter parse --quiet --stat < "$all" 2>&1 || true)

# Warning: **失敗不只有 `(ERROR`，還有 `(MISSING`。** 解析器補一個記號就能收尾的
# 時候印的是後者（語料裏 `ownership_cldiags.mojo` 就是），而 `tree-sitter` 把它一樣
# 算成失敗。只 grep `ERROR` 會比它自己報的總數少一個。
fails=$(printf '%s\n' "$out" | grep -oE '^/\S+\.mojo' || true)
f_all=$(printf '%s' "$fails" | grep -c . || true)
f_skip=$(printf '%s\n' "$fails" | sort -u | comm -12 - "$skip" | grep -c . || true)
f_real=$((f_all - f_skip))

pct() { python3 -c "import sys; n,f=int(sys.argv[1]),int(sys.argv[2]); print(f'{(n-f)*100/n:.2f}')" "$1" "$2"; }
printf '真實 Mojo：%s 個檔，%s 個沒過，%s%%\n' "$n_real" "$f_real" "$(pct "$n_real" "$f_real")"
printf '全語料：  %s 個檔，%s 個沒過，%s%%\n' "$n_all" "$f_all" "$(pct "$n_all" "$f_all")"

[ "${1:-}" = "--why" ] || exit 0
printf '\n真實 Mojo 裏出錯那一行，按構造分：\n'
printf '%s\n' "$out" | grep -E '^/\S+\.mojo' | python3 -c '
import re, sys, collections, pathlib
skip = set(l.strip() for l in open(sys.argv[1]))
pat = re.compile(r"^(\S+\.mojo)\s.*\((?:ERROR|MISSING[^[]*) \[(\d+), (\d+)\]")
seen = collections.Counter(); rows = collections.defaultdict(list); total = 0
for line in sys.stdin:
    m = pat.match(line)
    if not m: continue
    f = m.group(1)
    if f in skip: continue
    total += 1
    try: src = pathlib.Path(f).read_text(errors="replace").split("\n")[int(m.group(2))]
    except Exception: src = ""
    s = src.strip()
    if "__generator_type" in s: k = "__generator_type"
    elif "capturing" in s: k = "capturing"
    elif "`" in s and s.startswith("@"): k = "裝飾器裏的反引號標識符"
    elif re.search(r"\braises\b", s): k = "raises（含 raises {…}）"
    elif s.startswith("@"): k = "別的裝飾器"
    elif "__mlir" in s: k = "內嵌 MLIR"
    elif re.search(r"\bt\"", s): k = "t-string"
    elif ":=" in s: k = "海象 :="
    elif re.search(r"\bwhere\b", s): k = "where"
    elif re.search(r"\bdef\s*\(", s): k = "def(...) 當類型"
    elif re.search(r"\b(var|ref|owned|out|comptime|alias)\b", s): k = "var/ref/owned/out/comptime/alias"
    else: k = "其它"
    seen[k] += 1
    rows[k].append(f"{f}:{int(m.group(2))+1}  {s[:90]}")
run = 0
for k, n in seen.most_common():
    run += n
    print(f"{n:5}  ({run*100//max(total,1):3}% 累計)  {k}")
    for r in rows[k]: print(f"         {r}")
' "$skip"
