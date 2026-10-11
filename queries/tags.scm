; **What counts as a definition** — an outline, and a key that steps between them.
;
; The capture names are tree-sitter's own tagging convention (`@definition.*`
; with the bare name under `@name`), so anything that already reads a
; `tags.scm` reads this one.
;
; Warning: **a method is captured as `@definition.function`, not
; `@definition.method`.** Telling them apart needs the parent in the pattern
; (`struct_definition body: (block (function_definition …)))`), and then the
; plain rule matches the same node a second time — two captures of one range,
; for a distinction no consumer has asked for yet. One rule, until one does.
;
; Warning: **`alias` is missing, and that is the grammar's doing.** `alias Big = Int`
; parses as an ordinary `assignment`: nothing on the tree says the keyword was
; there, so there is nothing to match on. Giving `alias` a node of its own is a
; grammar change, not a query change.

(function_definition
  name: [(identifier) (backtick_identifier)] @name) @definition.function

(struct_definition
  name: [(identifier) (backtick_identifier)] @name) @definition.class

(trait_definition
  name: [(identifier) (backtick_identifier)] @name) @definition.class

(extension_definition
  name: [(identifier) (backtick_identifier)] @name) @definition.class
