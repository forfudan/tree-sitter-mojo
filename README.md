# tree-sitter-mojo

A [tree-sitter](https://tree-sitter.github.io) grammar for
[Mojo](https://www.modular.com/mojo), written from scratch rather than forked from
`tree-sitter-python`.

## Why not a fork

Every other published Mojo grammar forks `tree-sitter-python`. A fork starts by
assuming Python's answer everywhere and then hunting down the places Mojo differs —
`fn` against `def`, parameter lists in `[]`, `owned`/`ref`/`out` argument conventions,
`raises` and `capturing` on a signature, `match` with cases level with it, `__enum`,
t-strings, backtick identifiers.
Each of those is a rule somebody has to notice is missing.

This one reads the other way. Every rule is written against Mojo's own parser
(`Mojo/lib/MojoParser` in [modular/modular](https://github.com/modular/modular)) and
checked against the `.mojo` files in that same repository — nearly four thousand of
them, written by the people who designed the language.

It follows **Mojo 1.2** (tag `mojo/v1.2.0`): `match` and `comptime match`, `if case`,
`elif case` and `while case`, `case == value`, `*rest` and `as` inside patterns, comma
lists after `match` and `case`, `__enum` with its `case` members, and `__async`/`__await`.
The older spellings (`__match`, `async`, `await`) still parse, as they do in Mojo.

## The number

```
script/baseline.sh          # how much of the corpus parses with no ERROR node
script/baseline.sh --why    # and what the failures have in common
```

That is the whole measure of this project: a rule is worth adding when it moves the
number, and the grammar has drifted behind the language when the number falls. Point
it at your own checkout with `MOJO_SRC=/path/to/modular`.

It prints two figures. On Mojo 1.2 (`mojo/v1.2.0`) **real Mojo is at 99.77%** (9 of
3831 files fail), and the whole corpus at 98.09%; the second is there so older numbers
stay comparable. On Mojo 1.1 (the 2026-09-17 tree) the same grammar is at 99.75% (9 of
3585), as it was before the 1.2 rules went in.

The difference is 199 files that are not Mojo, excluded by path pattern:

- **`Mojo/tools/mblack/tests/data/`**, 116 files, matched without regard to case.
  `Mojo/tools/mblack/` is Modular's
  fork of **Black**, the Python formatter, and that directory holds Black's own Python
  fixtures renamed in bulk to `.mojo` (`py_39/python39.mojo`, `pep_572_py39.mojo`).
  They use `class`, `match`/`case` and `yield`, none of which Mojo implements.
- **the reference parser's negative tests**, 83 files ending in `errors.mojo` or
  `negative.mojo` *under a `test/` or `tests/` tree*. Modular's parser rejects them by
  design. The qualifier is needed: `Mojo/docs/site/code/manual/errors/`
  holds five real files whose names also end in `errors.mojo`.

The nine that still fail are themselves files Modular's parser rejects (each carries
`expected-error`, `RUN: not` or `-verify-diagnostics`); they simply are not named so.
Read a fall in the number, not its distance from 100.

## Layout

| | |
| --- | --- |
| `grammar.js` | the rules. Typed via `tree-sitter-cli`'s own `dsl.d.ts`, which is what `// @ts-check` at the top buys |
| `src/scanner.c` | the external scanner: `NEWLINE`, `INDENT`, `DEDENT`, `T_STRING`. Indentation needs a stack and a t-string body needs a brace counter; no regular expression has either. **The comment at the top is the contract**, eight clauses read out of tree-sitter's own `lexer.c` and `parser.c` |
| `src/parser.c` | generated, and **committed**, so everything downstream builds without node or the CLI |
| `test/corpus/` | `tree-sitter test` cases. The baseline says how far the grammar reaches; these pin the places it has already been wrong. Warning: `-u` rewrites **every** corpus file it reads, not only the one `--file-name` names, and drops the `//` headers |
| `script/baseline.sh` | the number above |

## Building

```
npm install -g tree-sitter-cli
tree-sitter generate --abi 15
tree-sitter parse some.mojo
```

Warning: keep `--abi 15`. The committed `parser.c` is ABI 15 so that the tree-sitter
0.25 runtime (ABI 13 to 15) can load it; a CLI that defaults to a newer ABI would
produce a parser that builds and then refuses to load.

## Licence

Copyright 2026 ZHU Yuhao. Licensed under the Apache License 2.0; see
[LICENSE](LICENSE).

No code is taken from any other Mojo grammar; the corpus and the reference
parser are Modular's, under Apache-2.0 with LLVM Exceptions.
