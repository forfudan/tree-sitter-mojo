/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// **Mojo，從頭寫起。**
//
// 不是 `tree-sitter-python` 的分支——現存那五六份都是，而那條路把 Python 的答案當
// 成 Mojo 的預設，錯在哪要一條一條找回來。這一份反過來：每一條規則都是照 Mojo 自己
// 的解析器（`~/Programs/mojo/mojo/lib/MojoParser`，Apache-2.0 with LLVM Exceptions）
// 和它那三千多個 `.mojo` 寫的，寫一條驗一條。
//
// **靶是那三千多個檔**（`script/baseline.sh`）。它一跑就說「這份語法解析得了多少」，
// 所以每一條規則值不值、語法有沒有往前漂，都是一個看得見的數字，不是感覺。
//
// Warning: **縮進歸 `src/scanner.c`。** `_newline`／`_indent`／`_dedent` 三個記號是
// 外部的——「這一行比上一行深」要記住外層每一級的深度，正則寫不出來。

// 優先級階梯，從鬆到緊。寫成名字是因為後面每一條二元規則都要引它，而數字散在各處
// 的時候，「`and` 比 `not` 鬆還是緊」要靠數數纔答得出來。
const PREC = {
  // `:=` 比三元式還鬆（Mojo 的 `kAssignExpr` 就排在 `kIfElse` 下面一級，
  // `ParserBase.h:255-258`），所以它在這張表的最底下。
  walrus: 1,
  conditional: 2,
  or: 3,
  and: 4,
  not: 5,
  compare: 6,
  // `var`／`ref` 當前綴的時候就在這一格（Mojo 的 `kVarRefPat`，排在 `kComparison`
  // 與 `kOr` 之間，`ParserBase.h:262-263`）。
  var_ref_pat: 7,
  bitwise_or: 8,
  bitwise_xor: 9,
  bitwise_and: 10,
  shift: 11,
  plus: 12,
  times: 13,
  unary: 14,
  power: 15,
  // `await` 擠在 `**` 與後綴鏈之間：`await a ** b` 是 `(await a) ** b`，而
  // `await f(x)` 是 `await (f(x))`——調用比它緊（Mojo 的 `kAwait` 就在 `kPrimary`
  // 下面一級，`ParserBase.h:253-280`）。
  awaited: 16,
  call: 17,
};

module.exports = grammar({
  name: "mojo",

  // Warning: **`t_string` 也在這裏，而它不是零寬的。** `t"A {t"B {v}"}"` 的身體要數
  // 大括號的層數，正則數不了；理由與縮進同一個，所以歸同一支掃描器。
  externals: ($) => [$._newline, $._indent, $._dedent, $.t_string],

  // **`primary_expression` 是一個上位類型，不是樹上的一個節點**（2026-10-11）。
  //
  // 它是一條純 `choice`，三十幾個分支全是具名規則——不宣告的話每一個表達式外面
  // 都多裹一層 `(primary_expression …)`：樹大了一倍，而下游每一條查詢都要為它
  // 多寫一級（`(conformance (identifier))` 寫不出來，得寫
  // `(conformance (primary_expression (identifier)))`）。宣告之後它從樹上消失，
  // 而 `node-types.json` 照樣說得出它有哪些子類型。`tree-sitter-python` 對同名
  // 的那條規則也是這麼宣告的。
  //
  // Warning: **這不改解析，只改可見性**——基準數字一個都不動。
  supertypes: ($) => [$.primary_expression],

  // 空白與註釋在任何兩個記號之間都可以出現，所以歸 `extras`，不往規則裏寫。
  // Warning: **換行不在這裏。** 它是語句的結束，是語法的一部分。
  // Warning: **換行也在這裏，而它同時是語句的結束。** 兩件事不矛盾：外部掃描器永遠
  // 先被問，它說「這裏可以結束一句」就交出 `_newline`，說不出來纔輪到這一行把換行
  // 當空白吃掉。括號裏的「隱式續行」靠的就是後者——`from a import (\n b,\n)` 的
  // 每一個換行在那裏都不結束語句，而掃描器數不了括號（它只在要外部記號的時候纔被
  // 叫到，看不見每一個字符）。2026-10-10 量出來的：語料裏這一族上千處。
  extras: ($) => [/[ \t]/, /\r?\n/, /\\\r?\n/, $.comment],

  word: ($) => $.identifier,

  // Warning: **這幾處是真的要回溯，不是規則寫壞了。** 一個 `(` 開頭的東西在看到
  // 裏面之前分不清是括號、元組還是生成器；`x: T` 在語句開頭分不清是標註賦值還是
  // 別的。tree-sitter 的辦法是在這裏點名，由它分兩路試。
  conflicts: ($) => [
    [$.parenthesised_expression, $.tuple],
    [$.primary_expression, $.pattern],
    [$.tuple, $.tuple_pattern],
    [$.list, $.list_pattern],
    [$.primary_expression, $.parametric_pattern],
    // 推導式裏 `for x in y if c` 的那個 `if`：過濾子句，還是「`y if c else …`」那個
    // 三元式的開頭。GLR 兩路並着試，沒有 `else` 的那一路只有過濾子句走得通。
    [$._expression, $._comprehension_iterable],
    [$.transfer, $.binary_operator],
    [$.transfer, $.binary_operator, $.unary_operator],
    [$.transfer, $.binary_operator, $.await_expression],
    // `__generator_type[` 之後那一格：方括號是參數表，還是「體類型是一個列表」。
    // Mojo 自己看見 `[` 就當參數表（`ParserExprs.cpp:1460`），而 LR 在讀到裏面
    // 之前分不出來——兩路並着試，參數表那一路纔接得上後面的體類型。
    [$._parameter_name, $.primary_expression],
    [$.parameter, $.primary_expression],
  ],

  rules: {
    // Warning: **一個落單的換行要有地方放。** 檔頭的註釋後面那個換行前面沒有語句
    // 可結束，塊的開頭同理；不收它的話解析器只能靠「補一個標識符」去恢復，整棵樹
    // 從第一行起就是錯的（寫完當場撞上）。
    module: ($) => repeat($._statement),

    _statement: ($) => choice($._simple_statement, $._compound_statement),

    // ---- 簡單語句 ---------------------------------------------------------

    // 一行可以用 `;` 串幾句，最後一句後面還可以多一個 `;`。
    _simple_statement: ($) =>
      seq($._simple, repeat(seq(";", $._simple)), optional(";"), $._newline),

    _simple: ($) =>
      choice(
        $.pass_statement,
        $.break_statement,
        $.continue_statement,
        $.return_statement,
        $.raise_statement,
        $.assert_statement,
        $.delete_statement,
        $.global_statement,
        $.nonlocal_statement,
        $.import_statement,
        $.import_from_statement,
        $.assignment,
        $.augmented_assignment,
        $.expression_statement,
      ),

    pass_statement: (_) => "pass",
    break_statement: (_) => "break",
    continue_statement: (_) => "continue",
    return_statement: ($) => seq("return", optional($._expressions)),
    raise_statement: ($) => seq("raise", optional(seq($._expression, optional(seq("from", $._expression))))),
    // `comptime assert` 是編譯期斷言（`ParserStmts.cpp:935-953`），同一條語句。
    assert_statement: ($) => seq(optional("comptime"), "assert", commaSep1($._expression)),
    delete_statement: ($) => seq("del", $._expressions),
    global_statement: ($) => seq("global", commaSep1($._name)),
    nonlocal_statement: ($) => seq("nonlocal", commaSep1($._name)),

    expression_statement: ($) => $._expressions,

    // ---- 綁定 -------------------------------------------------------------

    // **`var` 和 `comptime` 是 Mojo 自己的。** `var` 宣告一個可變綁定，`comptime`
    // 宣告一個編譯期常量（參數／別名）；兩者都可以帶類型標註，而 `comptime` 的右邊
    // 是編譯期求值的。語法上同一個形狀，關鍵字留在樹上。
    //
    // Warning: **`alias` 已經不是關鍵字了，`comptime` 頂替了它。** Mojo 的記號表
    // （`mojo/include/Mojo/MojoParser/TokenKinds.def`）裏沒有 `alias` 這一個；語料
    // 三千七百多個檔裏 `^\s*comptime ` 五萬兩千多行，`^\s*alias ` 只剩七行
    // （2026-10-10 數的，那七行在字串和註釋裏）。`alias` 還留在這條規則上只為了
    // 讀得了舊代碼，新語法以 `comptime` 為準。
    // Warning: **帶參數的 `comptime` 這裏沒有專門的一格。** `comptime MyInt[T: AnyType]
    // = T` 落在 `subscript` 那條路上（方括號裏那個 `T: AnyType` 成了一個 `slice`），
    // 樹的形狀不漂亮而解得開。補一格 `type_parameters` 試過，與 `pattern_list` 撞
    // （`comptime a, b[…]` 裏那個 `[` 是新的一個模式還是前一個的參數表，分不出來），
    // 所以擱着。
    // Warning: **`comptime` 另有兩個身份**，見 `comptime_statement`（`comptime if`／
    // `comptime for`）與 `comptime_expression`（`comptime (…)`）。
    assignment: ($) =>
      seq(
        optional(field("binding", choice("var", "comptime", "alias"))),
        field("left", $._left_hand_side),
        // Warning: **光一個目標不算一條賦值。** 三格全可選的時候 `f(x)` 這一句既是
        // 表達式語句又是「沒有值的賦值」，而 `comptime (…)` 更糟——那個括號被當成一
        // 個元組模式，於是前綴表達式那一條規則整個用不上（2026-10-10 加 `call` 進
        // `pattern` 之後當場踩到，`tree-sitter test` 攔住了）。所以標註、約束、值
        // 三者**至少要有一樣**。`var x` 在 Mojo 也不成立，一定帶類型或帶初值。
        choice(
          seq(
            ":",
            field("type", $._expression),
            optional(field("constraints", $.where_clauses)),
            optional(seq("=", field("right", $._right_hand_side))),
          ),
          seq(
            optional(field("constraints", $.where_clauses)),
            "=",
            field("right", $._right_hand_side),
          ),
        ),
      ),

    _right_hand_side: ($) => choice($._expressions, $.assignment),

    augmented_assignment: ($) =>
      seq(
        field("left", $._left_hand_side),
        field(
          "operator",
          choice("+=", "-=", "*=", "/=", "//=", "%=", "**=", ">>=", "<<=", "&=", "^=", "|=", "@="),
        ),
        field("right", $._expressions),
      ),

    _left_hand_side: ($) => choice($.pattern, $.pattern_list),

    pattern_list: ($) => seq($.pattern, choice(",", seq(repeat1(seq(",", $.pattern)), optional(",")))),

    // **賦值的左邊還可以是一個調用和一個反引號名字。** `u.unsafe_get[Int32]() = 100`
    // 走的是 setter（Mojo 的賦值左邊是一個表達式模式，`ExprPatterns.cpp`），
    // ``var `6bit` = …`` 的名字帶反引號（`escaped_identifier`）。
    pattern: ($) =>
      choice(
        $.identifier,
        $.backtick_identifier,
        $.attribute,
        $.subscript,
        $.call,
        $.tuple_pattern,
        $.list_pattern,
        $.splat_pattern,
        $.binding_pattern,
        $.parametric_pattern,
      ),

    // **帶參數的 `comptime` 宣告**：`comptime IteratorType[mut: Bool, //, origin:
    // Origin[mut=mut]]: AnyType`。方括號裏是一張**參數表**（帶約定詞、帶 `//` 標記），
    // 不是下標。
    // Warning: **這一條與下標真的撞**（`X[…]` 兩種都通），所以在 `conflicts` 裏點名，
    // 由 GLR 兩路並着試——`//` 那一種只有參數表走得通。點的是
    // `[$.primary_expression, $.parametric_pattern]`：撞點在「`identifier` 後面那個
    // `[`」，不在 `subscript` 本身（寫成 `[$.subscript, …]` 它回「unnecessary」）。
    parametric_pattern: ($) => seq($.identifier, $.type_parameters),

    // **`var` 和 `ref` 在表達式裏是前綴的模式運算符**，不只是語句開頭那個詞
    // （`ParserExprs.cpp:272-276`，優先級 `kVarRefPat`）。看得見的地方是迴圈的
    // 目標：`for ref x in y`、`for var (a, b) in z`。
    // Warning: **優先級壓低，讓語句開頭那個 `var` 歸宣告。** `var x` 在語句開頭兩種
    // 都通——`assignment` 的 `binding` 一格，或者一個 `binding_pattern` 自己當表達式
    // 語句。歸宣告纔有 `binding`／`type`／`right` 那幾格可用。
    binding_pattern: ($) => prec(-1, seq(choice("var", "ref"), $.pattern)),

    tuple_pattern: ($) => seq("(", optional(commaSepTrailing($.pattern)), ")"),
    list_pattern: ($) => seq("[", optional(commaSepTrailing($.pattern)), "]"),
    splat_pattern: ($) => seq(choice("*", "**"), $.pattern),

    // **`__mlir_region` 給一個 MLIR 操作定義一個區域**（`TokenKinds.def:163`）。
    // 產生式照 `ParserStmts.cpp:4278` 那一行註釋：
    //
    //     region_stmt ::= "__mlir_region" 名 "(" [實參表] ")" ":" suite
    //
    // 它的樣子（`stdlib/std/builtin/_coroutine.mojo:37`，庫代碼裏真用着）：
    //
    //     __mlir_region await_body(hdl: __mlir_type.`!co.routine`):
    //         body(hdl)
    //     __mlir_op.`co.suspend`[_region="await_body".value]()
    //
    // Warning: **它的實參比函數的參數窄，所以不借 `$.parameters`。** 那一支明說了
    // 「MLIR operations don't have input conventions」（`ParserStmts.cpp:4306`）：
    // 一個實參就是 `名 : 類型`，沒有約定詞、沒有默認值、沒有 `*`／`/`／`//` 分界。
    // 末尾那個逗號照收（`parseCommaSeparatedList` 收）。
    mlir_region_statement: ($) =>
      seq(
        "__mlir_region",
        field("name", $._name),
        field("parameters", $.mlir_region_parameters),
        ":",
        field("body", $.block),
      ),

    mlir_region_parameters: ($) =>
      seq("(", optional(commaSepTrailing($.mlir_region_parameter)), ")"),

    mlir_region_parameter: ($) =>
      seq(field("name", $._name), ":", field("type", $._expression)),

    // **`__match` 是 Mojo 自己那個模式匹配語句**（`TokenKinds.def:171`：
    // 「Experimental match statement」），不是 Python 的 `match`／`case`——那兩個詞
    // Mojo 的記號表裏根本沒有。產生式照 `ParserStmts.cpp:1557-1560` 頭上那三行註釋：
    //
    //     match_stmt ::= "__match" subject_expr ":" NEWLINE case_block+
    //     case_block ::= "case" pattern ["as" 名] ["if" 表達式] ":" suite
    //
    // ⚠️ **case 的縮進有兩種，而且都要收**（`ParserStmts.cpp:1604-1607` 那段註釋明說
    // 了：「Cases may share the match indent (Mojo style) or be indented beneath it
    // (Python style)」）。語料裏庫代碼走的是前一種（`layout/tile_tensor.mojo:190`
    // 那三處），`statements/match_diags.mojo` 兩種都寫了。兩條路在詞法那一層就分開
    // 了，不含糊：同深的下一行掃描器交 `_newline`，更深的交 `_indent`。
    match_statement: ($) =>
      seq(
        "__match",
        field("subject", $._expression),
        ":",
        choice(
          seq($._newline, repeat1($.case_clause)),
          seq($._indent, repeat1($.case_clause), $._dedent),
        ),
      ),

    // Warning: **模式不許是三元式。** Mojo 解那個模式的時候把下限釘在
    // `Precedence(int(kIfElse) + 1)`（`ParserStmts.cpp:1617`），就是為了讓後面那個
    // `if` 歸守衛、不被當成 `x if y else z` 的開頭。`:=`（`kAssignExpr`）與 `as`
    // （`kAsPat`）也在那條線以下，所以 `as` 是這裏明寫的一格，不是表達式裏的。
    // `kBoolOr` 及以上全收——`case 1 | 2:`、`case n if n < 0:` 就靠這個。
    // `case var x:`／`case ref x:` 走 `binding_pattern`（那兩個詞在 Mojo 是
    // `kVarRefPat` 的前綴運算符，比 `kBoolOr` 緊）。
    // Warning: **優先級比三元式高一級，不是隨手加的數。** 這一條就是「模式後面那個
    // `if` 一定是守衛」那句話的寫法：`a or b` 收完之後看見 `if`，歸約成模式（這一條）
    // 與移入三元式（`conditional_expression`，`PREC.conditional`）都通，而 Mojo 把
    // 模式的下限釘在 `kIfElse + 1`，三元式在那條線以下，所以歸約贏。
    _case_pattern: ($) =>
      prec(PREC.conditional + 1, choice(
        $.boolean_operator,
        $.not_operator,
        $.comparison_operator,
        $.primary_expression,
        $.binding_pattern,
      )),

    case_clause: ($) =>
      seq(
        "case",
        field("pattern", $._case_pattern),
        optional(seq("as", field("alias", $._name))),
        optional(seq("if", field("guard", $._expression))),
        ":",
        field("body", $.block),
      ),

    // ---- import -----------------------------------------------------------

    // Warning: **`import .inner` 收得下，而 Mojo 自己會報錯。** 模組路徑那一支是
    // 同一個（`parseImportModuleName`，產生式 `"."* module | "."+`），相對那幾個點
    // 照樣收進來；「相對 import 必須用 from」是**收完之後**的一句診斷
    // （`ParserStmts.cpp:3667-3680`），不是語法。這一層只管形狀，所以照收——語料裏
    // `test/mojo-parser/import/inputs/visibility_pkg/gateway.mojo` 就是這一種。
    import_statement: ($) => seq("import", commaSep1($._import_name)),

    _import_name: ($) => choice($.dotted_name, $.relative_import, $.aliased_import),
    aliased_import: ($) => seq(field("name", $.dotted_name), "as", field("alias", $._name)),

    // `from .a.b import c`、`from . import c`、`from a import *`、括號裏換行的一長串。
    import_from_statement: ($) =>
      seq(
        "from",
        field("module", choice($.dotted_name, $.relative_import)),
        "import",
        choice($.wildcard_import, $._import_list, seq("(", $._import_list, ")")),
      ),

    _import_list: ($) => commaSepTrailing($._import_name),
    relative_import: ($) => seq(repeat1("."), optional($.dotted_name)),
    wildcard_import: (_) => "*",
    dotted_name: ($) => sep1($._name, "."),

    // ---- 複合語句 ---------------------------------------------------------

    _compound_statement: ($) =>
      choice(
        $._definition,
        $.decorated_definition,
        $.if_statement,
        $.for_statement,
        $.while_statement,
        $.with_statement,
        $.try_statement,
        $.comptime_statement,
        $.match_statement,
        $.mlir_region_statement,
      ),

    // **`comptime if` 與 `comptime for` 在編譯期展開**，而語法上就是前面多一個詞
    // （`ParserStmts.cpp:935-953`：`comptime` 後面是 `assert`／`if`／`for` 三條路，
    // 都不是宣告）。只許出現在函數體裏——那是語義，這一層不管。
    comptime_statement: ($) =>
      seq("comptime", choice($.if_statement, $.for_statement)),

    // Warning: **被裝飾的是沒帶裝飾器的那一個。** 寫成「裝飾器 ＋ 任何複合語句」的話
    // `@a @b fn f` 兩種解釋都通——一個定義帶兩個裝飾器，還是一個裝飾器套着另一個
    // 帶裝飾器的定義——而那不是語言裏的歧義，是規則寫漏了一層。
    _definition: ($) =>
      choice($.function_definition, $.struct_definition, $.trait_definition, $.extension_definition),

    // **裝飾器的參數裏可以有反引號標識符**：`@__llvm_metadata(`nvvm.cluster_dim`=x)`。
    // 那是 MLIR 的屬性名，帶點，照普通標識符的規矩寫不出來——語料裏這一族有四十多處。
    // **裝飾器也掛在欄位宣告上**，不只掛在函數和結構上：
    // `@__allow_legacy_any_origin_fields` 後面跟的是 `var start: Pointer[…]`
    // （語料裏這一族三十多處）。所以被裝飾的那一格收簡單語句。
    decorated_definition: ($) =>
      seq(repeat1($.decorator), field("definition", choice($._definition, $._simple_statement))),

    decorator: ($) => seq("@", $._expression, $._newline),

    // **一個簽名的次序是照 Mojo 自己裝起來的那一串寫的**
    // （`DeclResolution.cpp:2222`／`2264`／`2280`／`2284`，逐行讀出來的）：
    //
    //     [async] fn|def 名 [參數的方括號] ( 實參 ) 效果* [捕獲表] [-> [ref] 類型]
    //             [where 約束]* ( : 塊 | 換行 )
    //
    // Warning: **效果在 `->` 前面，不在後面。** 第一版寫在後面，於是 `fn g() raises
    // -> Int:` 整個解不開——語料裏 `raises` 這一族一百六十多處全栽在這上頭
    // （2026-10-10 量的）。
    // Warning: **沒有 `:` 和塊的那一支是真的。** trait 裏的方法只宣告簽名
    // （`fn f(self)` 一行完），不帶身體。
    // **折行的簽名也收得下，而這一條不在語法裏。** `def f[x: Int]()` 換行、下一行縮進
    // 着寫 `where x:`——Mojo 靠縮進斷（`isTokenInCurrentStatement`，
    // `ParserBase.h:198-211`：比這一句深的下一行是續行）。從前這兩件事在語法那一層
    // 撞——無體方法與折行的簽名都要在簽名後面那個位置上收一個換行，而換行是外部記號，
    // 一交出來內部詞法器那一輪就不跑，GLR 也救不了。2026-10-11 搬到掃描器裏之後兩件
    // 事不再爭：**換行該不該交出來，由下一行的深度決定**（`src/scanner.c` 末尾那一
    // 句 `depth <= here`），這一層照寫 `$._newline` 就夠了。
    function_definition: ($) =>
      seq(
        optional("async"),
        field("kind", choice("fn", "def")),
        field("name", $._name),
        optional(field("type_parameters", $.type_parameters)),
        field("parameters", $.parameters),
        optional(field("effects", $.effects)),
        optional(field("captures", $.capture_list)),
        optional(
          seq("->", optional(seq("ref", optional($.origin_set))), field("return_type", $._expression)),
        ),
        optional(field("constraints", $.where_clauses)),
        choice(seq(":", field("body", $.block)), $._newline),
      ),

    // **效果是一串軟關鍵字。** Mojo 的詞法器裏 `raises`／`capturing`／`abi`／`thin`
    // 都只是標識符（`consumeIfSoftIdentifier`），能不能當效果看位置——tree-sitter 的
    // `word` 記號做的也是這件事，所以這幾個名字在別處照樣當變量名用。
    // 全部的名單在 `Signatures.cpp:1583-1588`：`raises`、`capturing`、`escaping`
    // （已廢）、`thin`（只用在函數類型上）、`register_passable`（已廢）、`abi`，
    // 外加 `where`——`where` 在那個循環裏是 `break`，所以它不是效果，是後面另一節。
    effects: ($) => repeat1($._effect),

    _effect: ($) =>
      choice($.raises_effect, "capturing", "thin", "register_passable", $.abi_effect),

    // `raises` 後面可以跟一個拋出的類型（`raises MyError`）。Mojo 的判準是「後面
    // 那個記號能開始一個基本表達式，而且不是另一個效果詞、不是 `{`、不在新的一行」
    // （`Signatures.cpp:1636-1644`）——`{` 要留給捕獲表。
    raises_effect: ($) => prec.right(seq("raises", optional(field("thrown", $.thrown_type)))),

    // Warning: **拋出類型只收一個帶點的名字，這是故意收窄的。** Mojo 那邊它是一個
    // 「基本表達式」，而基本表達式裏有 `{…}`——`raises {imm}` 的捕獲表就會被當成一個
    // 集合字面量吃掉。改寫成 `choice($.identifier, $.subscript, …)` 也不行：`subscript`
    // 的對象是 `primary_expression`，`{` 照樣從那裏進得來。
    // 收窄的代價量過：語料裏 `raises {` 六百四十多處，而拋出類型總共不到兩百處、
    // **每一處都是一個光名字**（`StopIteration` 五十六處，其餘是 `Int`／`Float32`／
    // `String`／`NetworkError`，2026-10-10 數的）。
    // Warning: **往右結合。** 函數類型裏 `raises a.b` 的那個 `.` 可以是名字的下一節，
    // 也可以是「把整個函數類型取了成員」——往右收就歸名字。
    // **括號裏的拋出類型也收**：`def f() raises (Int) -> String`
    // （`decls/decls.mojo:594`，語料裏就這一處）。括號不把 `{` 放回來，所以上面那個
    // 收窄的理由不受影響。
    thrown_type: ($) =>
      prec.right(choice(sep1($._name, "."), seq("(", $._expression, ")"))),

    abi_effect: ($) => seq("abi", "(", field("convention", $.string), ")"),

    // **捕獲表**：`def f() {imm}:`、`{ref}`、`{var x^, mut y}`。
    // 產生式照 `Signatures.cpp:1452-1453` 那兩行註釋：
    //     capture_list ::= "{" capture_item ("," capture_item)* [","] "}" | "{}"
    //     capture_item ::= capture_convention [identifier^] | identifier | identifier^
    // 約定是 `var`（帶 `^` 就是移動）、`mut`、`imm`、`read`（已廢）、`ref`。
    capture_list: ($) => seq("{", optional(commaSepTrailing($.capture_item)), "}"),

    capture_item: ($) =>
      choice(
        seq(
          field("convention", choice(seq("var", optional("^")), "mut", "imm", "read", "ref")),
          optional(seq(field("name", $._name), optional("^"))),
        ),
        seq(field("name", $._name), optional("^")),
      ),

    // Mojo 的泛型參數走方括號：`fn f[T: AnyType](x: T)`。
    type_parameters: ($) => seq("[", optional(commaSepTrailing($.parameter)), "]"),

    struct_definition: ($) =>
      seq(
        "struct",
        field("name", $._name),
        optional(field("type_parameters", $.type_parameters)),
        optional(field("traits", $.conformance_list)),
        optional(field("constraints", $.where_clauses)),
        ":",
        field("body", $.block),
      ),

    trait_definition: ($) =>
      seq(
        "trait",
        field("name", $._name),
        optional(field("type_parameters", $.type_parameters)),
        optional(field("traits", $.conformance_list)),
        optional(field("constraints", $.where_clauses)),
        ":",
        field("body", $.block),
      ),

    // **`__extension` 給一個已有的結構加方法與符合性**，Mojo 自己的語句之一
    // （`ParserStmts.cpp:776`、`DeclResolution.cpp:4947`）。後面跟的是一個**光名字**，
    // 沒有方括號參數（解析器那一支只讀一個 `parseIdentifier`），再跟一張符合性列表。
    // 語料裏八十三處，而 2026-10-10 量的時候 258 個失敗檔裏有 45 個是栽在它上面的。
    extension_definition: ($) =>
      seq(
        "__extension",
        field("name", $._name),
        optional(field("traits", $.conformance_list)),
        optional(field("constraints", $.where_clauses)),
        ":",
        field("body", $.block),
      ),

    // **符合性列表不是實參列表。** 產生式照 `DeclResolution.cpp:3303-3306` 那幾行
    // 註釋（它們就寫在那支 `parseOptionalConformanceListSyntax` 的頭上）：
    //
    //     conformance_list ::= "(" [conformance ("," conformance)* [","]] ")"
    //     conformance      ::= 類型表達式 ["where" 條件] ["else" 消息]
    //                        | "not" 類型表達式 ["else" 消息]
    //
    // 所以 `struct Foo(Movable where False):` 裏那個 `where` 是**括號裏面**的——
    // 條件符合。語料裏四十多處（`mojo/test/mojo-parser` 底下尤其多）。
    conformance_list: ($) => seq("(", optional(commaSepTrailing($.conformance)), ")"),

    conformance: ($) =>
      choice(
        seq("not", $._expression, optional(seq("else", $._expression))),
        seq($._expression, optional($.where_clause)),
      ),

    // **`where` 是約束，不是效果。** Mojo 那個效果循環撞上 `where` 就 `break`
    // （`Signatures.cpp:1714`），由外面另一支收；函數上它在 `->` 之**後**
    // （`DeclResolution.cpp:2280` 先解結果類型，`2284` 纔解 `where`）。
    // Warning: **往右結合。** 一個函數類型後面接幾條 `where` 的時候，「這一條是這一串
    // 的最後一條，還是外面那一串的頭一條」分不出來——往右收就都歸裏面那一串。
    where_clauses: ($) => prec.right(repeat1($.where_clause)),

    where_clause: ($) =>
      prec.right(
        seq(
          "where",
          field("condition", $._expression),
          optional(seq("else", field("message", $._expression))),
        ),
      ),

    if_statement: ($) =>
      seq(
        "if",
        field("condition", $._expression),
        ":",
        field("consequence", $.block),
        repeat($.elif_clause),
        optional($.else_clause),
      ),

    elif_clause: ($) => seq("elif", field("condition", $._expression), ":", field("consequence", $.block)),
    else_clause: ($) => seq("else", ":", field("body", $.block)),

    for_statement: ($) =>
      seq(
        "for",
        field("left", $._left_hand_side),
        "in",
        field("right", $._expressions),
        ":",
        field("body", $.block),
        optional($.else_clause),
      ),

    while_statement: ($) =>
      seq("while", field("condition", $._expression), ":", field("body", $.block), optional($.else_clause)),

    with_statement: ($) => seq("with", commaSep1($.with_item), ":", field("body", $.block)),
    with_item: ($) => seq($._expression, optional(seq("as", $.pattern))),

    try_statement: ($) =>
      seq(
        "try",
        ":",
        field("body", $.block),
        choice(
          seq(repeat1($.except_clause), optional($.else_clause), optional($.finally_clause)),
          $.finally_clause,
        ),
      ),

    except_clause: ($) =>
      seq("except", optional(seq($._expression, optional(seq("as", $.identifier)))), ":", $.block),
    finally_clause: ($) => seq("finally", ":", $.block),

    // **塊可以只是冒號後面那一句**：`def foo(): pass`、`if a: return 1`。
    // Warning: **兩條路分得清，不用寫前瞻。** 縮進那一條要掃描器交出 `INDENT`，而
    // 掃描器只在「冒號後面真的換了行、而且下一行更深」的時候交得出來；同一行接着
    // 寫的時候它一個記號都不交，自然走下面那一條。
    block: ($) =>
      choice(seq($._indent, repeat($._statement), $._dedent), $._simple_statement),

    // ---- 參數 -------------------------------------------------------------

    parameters: ($) => seq("(", optional(commaSepTrailing($.parameter)), ")"),

    // **參數前面那個詞是所有權約定**，Mojo 特有。名單照 `Signatures.cpp:266-296`：
    // `var`（拿一份自己的）、`imm` 只讀、`mut` 可改、`out` 寫出去、`deinit` 析構，
    // 外加 `ref`——`ref` 和 `out` 後面還能帶一個方括號的來源集（`ref [origin] x`）。
    // `read` 已廢（Mojo 報錯叫改 `imm`），`owned`／`inout`／`borrowed` 是更早的拼法，
    // 留着只為讀得了舊代碼。
    //
    // 三個獨立的記號是調用約定的分界（`Signatures.cpp:302-321`、`Signatures.h:52-64`）：
    // `*` 同 Python（後面的只能用關鍵字傳），`/` 同 Python（前面的只能按位置傳），
    // **`//` 是 Mojo 自己的**——它前面那些參數是「只推不傳」的，調用方根本寫不出來，
    // 而且它只許出現在方括號的參數表裏。次序必須是 `//`、`/`、`*`。
    //
    // Warning: **方括號的參數表裏這幾個約定詞是參數名，不是約定**
    // （`Signatures.cpp:254-264`）：`[out: Int]` 裏 `out` 是名字。這裏靠「約定後面一定
    // 要跟一個名字」自然分開，不另寫一條規則。
    parameter: ($) =>
      choice(
        "/",
        "//",
        "*",
        seq(
          optional(
            field(
              "convention",
              choice(
                seq(choice("ref", "out"), optional($.origin_set)),
                "var",
                "imm",
                "mut",
                "deinit",
                "read",
                "owned",
                "inout",
                "borrowed",
              ),
            ),
          ),
          optional(field("variadic", choice("*", "**"))),
          field("name", $._parameter_name),
          // **可變參數包的類型前面還有一個 `*`**：`*args: *ArgTypes`
          // （`Signatures.cpp:363-390`，`VariadicKind::PackVarArg`）。
          optional(seq(":", optional("*"), field("type", $._expression))),
          optional(seq("=", field("default", $._expression))),
        ),
        // **函數類型裏參數名可以不寫，只寫類型**（`Signatures.cpp:340-346`：
        // `kFnTypeArgList` 那一檔名字是可選的）：`def(SIMD[dtype, width], Int) -> T`、
        // `Some[def(var Self.T)]`。
        // Warning: **這裏不收光標識符。** `def(Int, Int)` 裏那個 `Int` 走上面那一支
        // 當名字去了，兩種形狀在語法上分不開（Mojo 自己也把「全不具名」當成一種
        // 特例來處理，`Signatures.cpp:689-703`）。收的是一眼看得出不是名字的那幾種：
        // 帶點的、帶方括號的、調用、函數類型。
        seq(
          optional(
            field("convention", choice(seq(choice("ref", "out"), optional($.origin_set)), "var", "imm", "mut", "deinit")),
          ),
          field("type", choice($.attribute, $.subscript, $.call, $.function_type, $.dot_member)),
        ),
        // **不具名的參數也寫得成 `:類型`。** `Signatures.cpp:361` 那一句是
        // `if (p.consumeIf(Token::colon) || !name)`——函數類型的參數表裏名字可省，而
        // 冒號照樣寫得出來：`comptime IntToFloat32Type = def (:Int) thin -> FloatDyn`
        // （`decls/decls.mojo:34`）。這一支收得窄而不含糊：開頭一個冒號，名字不可能
        // 這麼開頭，所以上面那兩支都進不來。
        // Warning: **這一支前面不收約定詞**，雖然 Mojo 收。`fn(mut: Int)` 兩種都讀得
        // 通——`mut` 是那個參數自己的名字（上面那一支，軟關鍵字當名字），還是一個約定
        // 詞後面跟着不具名的 `: Int`。語料裏沒有後一種，所以這裏只收光的 `:類型`。
        seq(":", optional("*"), field("type", $._expression)),
      ),

    // Warning: **軟關鍵字的那幾個約定詞自己也能當參數名。** 方括號的參數表裏
    // `[mut: Bool, //, origin: Origin[mut=mut]]` 第一個就是叫 `mut` 的參數
    // （`Signatures.cpp:254-264`：方括號裏這幾個詞不當約定看）。tree-sitter 的
    // `word` 記號在「`mut` 這個關鍵字」與「標識符」都收得下的狀態裏一律挑關鍵字，
    // 所以這裏要明寫出來——不寫的話 `mut: Bool` 在 `:` 那一步死掉，語料裏這一族
    // 幾十處。`var` 和 `ref` 不在這張名單上：那兩個在 Mojo 是硬關鍵字。
    // Warning: **這裏明寫兩支，不走 `$._name`。** 形狀一樣，可是 `_name` 遍佈全樹，
    // 而 `__generator_type[` 之後「參數名 vs 列表元素」那一對撞要在 `conflicts` 裏
    // 點名——點 `_name` 就等於把那條 GLR 岔路鋪到每一個讀名字的地方去。
    _parameter_name: ($) =>
      choice(
        $.identifier,
        $.backtick_identifier,
        alias(
          choice("mut", "out", "imm", "read", "deinit", "owned", "inout", "borrowed"),
          $.identifier,
        ),
      ),

    // **來源集**：`ref [origin] x`、`-> ref [o] Int`、函數類型上 `capturing[_] -> Bool`。
    // 產生式是 `"[" 表達式表 "]"`（`ParserBase.cpp:232-243`）。
    // Warning: **優先級要壓過 `list`。** `-> ref [o] T` 裏那個 `[o]` 兩種都通——一個
    // 列表字面量當返回類型，或者一個來源集後面再跟類型。Mojo 要的是後者（`ref`
    // 的結果**一定**要有來源說明，`Signatures.cpp:1744-1754`）。
    origin_set: ($) => prec(1, seq("[", commaSepTrailing($._expression), "]")),

    // ---- 表達式 -----------------------------------------------------------

    _expressions: ($) => choice($._expression, $.expression_list),
    expression_list: ($) => seq($._expression, repeat1(seq(",", $._expression)), optional(",")),

    _expression: ($) =>
      choice(
        $.conditional_expression,
        $.boolean_operator,
        $.comparison_operator,
        $.not_operator,
        $.lambda,
        $.named_expression,
        $.primary_expression,
      ),

    conditional_expression: ($) =>
      prec.right(PREC.conditional, seq($._expression, "if", $._expression, "else", $._expression)),

    // **海象的左邊是一整個表達式，不只是一個名字。** Mojo 把 `:=` 當成一個普通的中綴
    // 運算符（`ParserExprs.cpp:281`，優先級 `kAssignExpr`、左結合），左邊就是前面解出
    // 來的那個表達式——語料裏 `self.a = self.b := MemExample()`（成員）、
    // `print(field.value := 1, …)`（成員）、`use(((a, b) := Tuple(1, 2))[0])`（元組）
    // 三種都有。叫它 `named_expression` 是沿用舊名，左邊那一格因此不再是「名字」。
    named_expression: ($) =>
      prec.left(
        PREC.walrus,
        seq(field("target", $._expression), ":=", field("value", $._expression)),
      ),

    // Warning: **Mojo 的 lambda 不是 Python 的 lambda。** 參數要有括號，而且帶得了
    // 類型標註、效果、捕獲表和返回類型（`ParserExprs.cpp:1474-1475` 那條產生式）：
    //
    //     lambda [方括號參數] [(實參)] 效果* [捕獲表] [-> 類型] : 表達式
    //
    // 不帶括號的 Python 寫法 Mojo 自己當場報錯（`ParserExprs.cpp:1500-1508`），所以
    // 「`lambda x: …` 那個冒號是類型還是體」這個歧義在 Mojo 裏不存在——括號分開了。
    // 語料裏的樣子：`lambda (i: Int) {ref} -> MutPointer[…]: …`。
    lambda: ($) =>
      prec(
        -1,
        seq(
          "lambda",
          optional(field("type_parameters", $.type_parameters)),
          optional(field("parameters", $.parameters)),
          optional(field("effects", $.effects)),
          optional(field("captures", $.capture_list)),
          optional(
            seq("->", optional(seq("ref", optional($.origin_set))), field("return_type", $._expression)),
          ),
          ":",
          field("body", $._expression),
        ),
      ),

    boolean_operator: ($) =>
      choice(
        prec.left(PREC.and, seq($._expression, "and", $._expression)),
        prec.left(PREC.or, seq($._expression, "or", $._expression)),
      ),

    not_operator: ($) => prec(PREC.not, seq("not", $._expression)),

    // Warning: **`comptime` 當表達式用的時候後面一定是括號。** Mojo 自己擋的
    // （`ParserExprs.cpp:519-532`：「We limit comptime subexpression to have parens
    // after it」，少了括號當場報錯），所以這裏不寫成一般的前綴運算符——寫成一般的
    // 前綴，`comptime x = 1` 那條宣告就會與它撞。
    comptime_expression: ($) =>
      prec(PREC.call, seq("comptime", choice($.parenthesised_expression, $.tuple))),

    // 比較可以串起來（`a < b <= c`），所以是 `repeat1`，不是兩個操作數。
    comparison_operator: ($) =>
      prec.left(
        PREC.compare,
        seq(
          $.primary_expression,
          repeat1(
            seq(
              choice("<", "<=", "==", "!=", ">=", ">", "in", seq("not", "in"), "is", seq("is", "not")),
              $.primary_expression,
            ),
          ),
        ),
      ),

    primary_expression: ($) =>
      choice(
        $.identifier,
        $.backtick_identifier,
        $.dot_member,
        $.integer,
        $.float,
        $.string,
        $.t_string,
        $.concatenated_string,
        $.true,
        $.false,
        $.none,
        $.ellipsis,
        $.call,
        $.attribute,
        $.subscript,
        $.tuple,
        $.list,
        $.dictionary,
        $.set,
        $.parenthesised_expression,
        $.list_comprehension,
        $.set_comprehension,
        $.dictionary_comprehension,
        $.generator_expression,
        $.await_expression,
        $.binary_operator,
        $.unary_operator,
        $.transfer,
        $.comptime_expression,
        $.function_type,
        $.generator_type,
        $.binding_expression,
      ),

    binary_operator: ($) => {
      const table = [
        [PREC.plus, choice("+", "-")],
        [PREC.times, choice("*", "/", "//", "%", "@")],
        [PREC.shift, choice("<<", ">>")],
        [PREC.bitwise_and, "&"],
        [PREC.bitwise_xor, "^"],
        [PREC.bitwise_or, "|"],
      ];
      return choice(
        ...table.map(([p, op]) =>
          prec.left(Number(p), seq($.primary_expression, op, $.primary_expression)),
        ),
        // `**` 往右結合：`2 ** 3 ** 2` 是 `2 ** (3 ** 2)`。
        prec.right(PREC.power, seq($.primary_expression, "**", $.primary_expression)),
      );
    },

    unary_operator: ($) => prec(PREC.unary, seq(choice("+", "-", "~"), $.primary_expression)),

    // **`var` 和 `ref` 也是前綴運算符**，與 `not`／`-`／`await` 同一族
    // （`ParserExprs.cpp:510-511` 那個 `switch` 裏它們就排在 `kw_not` 旁邊，優先級
    // `kVarRefPat`，`ParserExprs.cpp:469-472`）。所以它們進得了元組、進得了調用的
    // 關鍵字實參：`case (var x, 0):`、`case Point(x=var x, y=0):`
    // （`statements/match.mojo:386`、`mojo-integration/pattern_matching.mojo:138`）。
    // Warning: **這一條與 `binding_pattern` 是兩回事，別合。** 那一條在 `pattern` 裏，
    // 收的是賦值左邊與迴圈目標（`for var (a, b) in z`，裏面是一個 `tuple_pattern`）；
    // 這一條在表達式裏，操作數是 `primary_expression`。合起來就要把整個 `pattern`
    // 拖進表達式的每一個位置，而 `var x[…]` 在那裏與 `parametric_pattern` 撞成三路。
    binding_expression: ($) =>
      prec(PREC.var_ref_pat, seq(choice("var", "ref"), $.primary_expression)),

    // `await` 在 Mojo 的優先級階梯上是 `kAwait`，**比 `**` 還緊**，只差 `kPrimary`
    // 一級（`ParserBase.h:253-280`）——所以 `await a ** b` 是 `(await a) ** b`，
    // `await a + await b` 是 `(await a) + (await b)`。
    await_expression: ($) => prec(PREC.awaited, seq("await", $.primary_expression)),


    // **後綴 `^` 是所有權轉移**（`consume(x^)`），Mojo 特有。
    //
    // Warning: **同一個 `^` 也是按位異或**，而兩邊都說得通：`a ^ b` 是異或，`f(x^)`
    // 是轉移。Mojo 自己的解析器怎麼斷的——`ParserExprs.cpp:732-746`——是先當後綴吃
    // 下來，看後面那個記號能不能開始一個基本表達式（`isPrimaryExprStart`，同一句
    // 之內，而且不算 `.`：`a^.b` 是「轉移了再取成員」，不是 `a ^ (.b)`），能就回溯
    // 改當中綴。tree-sitter 沒有回溯，有的是 GLR：`conflicts` 裏點名這一對，它兩路
    // 並着試，哪一路解得完整算哪一路。空白不算數——Mojo 的詞法器對 `^` 不看空白
    // （`Lexer.cpp:381`），所以 `a ^b` 和 `a^ b` 在它那裏是同一回事。
    //
    // Warning: **兩處樹的形狀與 Mojo 不同，而兩處都不出 ERROR**，所以基線看不見：
    // `a ^ -b` 這裏斷成 `(a^) - b`（Mojo 斷成 `a ^ (-b)`，因為 `-` 也算基本表達式的
    // 開頭），`-a^` 這裏斷成 `(-a)^`（Mojo 是 `-(a^)`，後綴在 primary 的後綴鏈上）。
    // 試過 `prec.dynamic` 扳回來，沒有用——這一對是建表的時候就分掉的，不到動態
    // 優先級那一步。語料裏這兩種寫法一處都沒有，所以擱着；真要修就得把後綴鏈從
    // 二元階梯裏拆出來，那是另一件事。
    transfer: ($) => prec.left(PREC.call, seq($.primary_expression, "^")),

    // Warning: **參數的方括號不是 `call` 的一格，是 `subscript`。** `f[T](x)` 這裏
    // 是 `call(subscript(f, T), x)`——Mojo 自己也這麼切（`ParserExprs.cpp:724`，後綴
    // 鏈上 `[` 走 `parseSubscriptSuffix`、`(` 走調用），而且寫成 `call` 自己的一格
    // 會與 `subscript` 撞：`f[a, b](c)` 兩種解釋都通，那不是語言裏的歧義。
    call: ($) =>
      prec(
        PREC.call,
        seq(field("function", $.primary_expression), field("arguments", $.argument_list)),
      ),

    argument_list: ($) => seq("(", optional(commaSepTrailing($._argument)), ")"),

    _argument: ($) => choice($._expression, $.keyword_argument, $.splat_argument),
    keyword_argument: ($) =>
      seq(field("name", $._name), "=", field("value", $._expression)),
    splat_argument: ($) => seq(choice("*", "**"), $._expression),

    // **點後面也可以是反引號標識符。** `__mlir_type.`!kgen.string``、
    // `__mlir_op.`pop.external_call`[…]()`——MLIR 的類型與操作名帶 `!`、`#`、`<>`，
    // 普通標識符的規矩寫不出來，Mojo 自己有一個 `escaped_identifier` 記號
    // （`TokenKinds.def:47`），點後面照樣收（`ParserExprs.cpp:1121-1137`）。
    attribute: ($) =>
      prec(
        PREC.call,
        seq(
          field("object", $.primary_expression),
          ".",
          field("attribute", $._name),
        ),
      ),

    // **前綴點是省略了類型名的成員**：`@inline(.always)`、`SIMD[.float32]`、
    // `BarrierScope.CLUSTER` 寫成 `.CLUSTER`。省掉的那一截由編譯器從上下文推，而
    // 語法這一層只要認得出「點開頭的那個名字自己就是一個表達式」。
    // 語料裏這一族是**最大的一塊**：光 `.always` 八千多處，`--why` 的 2817 個失敗檔
    // 裏最內層那個 ERROR 落在前綴點上的有五百七十個（2026-10-10 量的）。
    // 後面照樣接得上點、方括號和括號——`.cast[...]()` 由 `attribute`／`subscript`／
    // `call` 把它當對象收下去，不用在這裏再寫一遍。
    dot_member: ($) => prec(PREC.call, seq(".", field("attribute", $._name))),

    // **方括號裏放的和括號裏放的是同一種東西。** `Origin[mut=True]`、
    // `[mut=True, Float32, _]`——Mojo 的方括號收關鍵字參數和解包，不只收下標。
    // Warning: **空的方括號要留一條路**：`ptr[]` 是解引用（語料裏幾十處），不是
    // 寫漏了下標。
    subscript: ($) =>
      prec(
        PREC.call,
        seq(
          field("value", $.primary_expression),
          "[",
          optional(commaSepTrailing(choice($._argument, $.slice, $.keyword_slice))),
          "]",
        ),
      ),

    // **關鍵字參數的值也可以是一段切片**：`s[byte=0:5]`、`str_slice[byte=:5]`、
    // `slice[grapheme=start:end]`——Mojo 的下標與調用共用同一支操作數解析
    // （`ParserExprs.cpp:1141-1174`），而切片只有下標裏有。
    keyword_slice: ($) =>
      seq(
        field("name", $._name),
        "=",
        field("value", $.slice),
      ),

    slice: ($) =>
      seq(optional($._expression), ":", optional($._expression), optional(seq(":", optional($._expression)))),

    // **推導式**，同 Python：`[i for i in range(n)]`、`{x for x in y if x & 1}`、
    // `{k: v for k, v in pairs}`、`(x for x in y)`。
    // Warning: **`for` 後面那個 `in` 的右邊不許收 `if`。** `for x in y if c` 裏那個
    // `if` 是推導式自己的過濾子句，而 `_expression` 裏有三元的 `a if b else c`——
    // 收進去就把 `if c` 當成一個沒有 `else` 的三元式吃掉，然後整條都不成。
    list_comprehension: ($) => seq("[", $._expression, $._comprehension_clauses, "]"),
    set_comprehension: ($) => seq("{", $._expression, $._comprehension_clauses, "}"),
    dictionary_comprehension: ($) => seq("{", $.pair, $._comprehension_clauses, "}"),
    generator_expression: ($) => seq("(", $._expression, $._comprehension_clauses, ")"),

    _comprehension_clauses: ($) =>
      seq($.for_in_clause, repeat(choice($.for_in_clause, $.if_clause))),

    for_in_clause: ($) =>
      seq(
        optional("async"),
        "for",
        field("left", $._left_hand_side),
        "in",
        field("right", $._comprehension_iterable),
      ),

    _comprehension_iterable: ($) =>
      choice($.boolean_operator, $.comparison_operator, $.not_operator, $.primary_expression),

    if_clause: ($) => seq("if", $._expression),

    parenthesised_expression: ($) => seq("(", $._expression, ")"),
    tuple: ($) => seq("(", optional(commaSepTrailing($._expression)), ")"),
    list: ($) => seq("[", optional(commaSepTrailing($._expression)), "]"),
    // **大括號裏還能寫 `名 = 值`，那是初始化列表。** Mojo 的擴展
    // （`ParserExprs.cpp:1029-1034`）：`{a, kwarg=42}` 在推得出類型的地方等於
    // `T(a, kwarg=42)`，語料裏 `alloc[Int8]({count = n})` 這一族就是它。
    // 哪一種由**第一項**決定（`ParserExprs.cpp:1038-1076`）：第一項是 `k: v` 或
    // `**x` 就是字典，否則是集合／初始化列表，兩種混寫是 Mojo 自己報的錯。
    // Warning: **`{}` 是空的初始化列表**，由 `dictionary` 那一條的 `optional` 收。
    set: ($) => seq("{", commaSepTrailing(choice($._expression, $.keyword_argument)), "}"),
    dictionary: ($) => seq("{", optional(commaSepTrailing(choice($.pair, $.splat_argument))), "}"),
    pair: ($) => seq(field("key", $._expression), ":", field("value", $._expression)),

    // **內嵌 MLIR 沒有自己的規則，這是故意的。** `__mlir_type`／`__mlir_op`／
    // `__mlir_attr`／`__mlir_region` 照普通標識符的規矩就寫得出來，後面那一串
    // （`.`、`[…]`、`(…)`）走的是 `attribute`／`subscript`／`call` 同一條後綴鏈——
    // Mojo 自己也是這麼切的。要補的只有兩件，都補了：點後面收反引號標識符
    // （見 `attribute`），方括號裏收關鍵字參數（見 `subscript`）。
    // 2026-10-10 數過語料裏這一族的形狀：`X[…]` 275 處、`X.X` 192 處、
    // `X.\`…\`[…]` 140 處、`X.\`!…\`` 一百多處，沒有一種需要專門的規則。
    // 第一版寫過一條 `mlir_literal`，它只認 `[` 那一種，於是 `X.\`…\`` 全不過。

    // **函數類型是一個表達式**：`F: def() -> V`、`def(imm MemType) thin -> None`、
    // `def(T, T) capturing[_] -> Bool`。產生式照 `ParserExprs.cpp:1394-1395`：
    //
    //     [async] def [方括號參數] (實參) 效果* [來源集] [-> 類型] [where 約束]*
    //
    // Warning: **`thin` 只用在函數類型上**（`Signatures.cpp:1653-1661`），而 `where`
    // 在函數類型上**只有帶了 `thin` 纔合法**（`ParserExprs.cpp:1437-1442`）——兩條都是
    // 語義檢查，這一層照收。
    // Warning: **`fn(…) -> T` 這種寫法 Mojo 已經廢了**（`ParserExprs.cpp:1406-1409`
    // 收下來就報錯，叫改 `def`）。這裏照收，為的是讀得了舊代碼。
    // Warning: **`prec.right` 是必要的。** 效果後面那個 `[` 可以是來源集，也可以是
    // 「把整個函數類型下標了」——後者在語言裏沒有意義，而 LR 分不出來。往右結合就是
    // 「能接着收就接着收」。
    function_type: ($) =>
      prec.right(seq(
        optional("async"),
        field("kind", choice("def", "fn")),
        optional(field("type_parameters", $.type_parameters)),
        field("parameters", $.parameters),
        // Warning: **來源集掛在效果後面，不是掛在括號後面。** 產生式上 `[effects]`
        // 與 `[origin_set]` 各自可選，可是 `def(T, T)` 後面直接一個 `[` 兩種都通
        // （一個來源集，還是把這整個函數類型下標了），分不出來。語料裏那一族一律
        // 寫成 `capturing[_]`——效果在前，所以綁在一起就不含糊了。
        optional(seq(field("effects", $.effects), optional(field("origins", $.origin_set)))),
        optional(
          seq("->", optional(seq("ref", optional($.origin_set))), field("return_type", $._expression)),
        ),
        optional(field("constraints", $.where_clauses)),
      )),

    // **`__generator_type` 是一個類型字面量**，產生式照 `ParserExprs.cpp:1452`：
    //
    //     "__generator_type" [方括號參數] 類型表達式
    //
    // 它造出來的是 `!lit.generator<<參數> 體>`，用處是「參數化的類型」：
    // `Mapper: __generator_type[Idx: Int] Int` 說的是「一個吃 `Idx: Int`、
    // 給出 `Int` 的生成器」。方括號那一段可省（`__generator_type Int` 就是沒有
    // 參數的那一種），所以關鍵字後面直接跟體類型也要收。
    // Warning: **`prec.right` 是必要的**——體類型是一整個表達式，而
    // `__generator_type[Idx: Int] ToT` 裏的 `[Idx: Int]` 也可以讀成「把關鍵字
    // 下標了」。往右收就是「方括號先當參數，剩下的全算體」。
    // Warning: **源碼裏沒有 `where` 這一段。** 語料裏凡是
    // `__generator_type[…] AnyType where cond` 那種寫法，都在 `CHECK:` 註釋或
    // 診斷文字裏——那是解析器**印**出來的形狀，不是收得進去的形狀
    // （`ParserExprs.cpp:1457-1471` 只收參數與體兩段）。
    // Warning: **參數那一段要自己一條規則，不能直接借 `type_parameters`。**
    // `__generator_type[] …` 裏那個 `[]` 兩種都讀得通（空參數表，還是「體類型是一
    // 個空列表」），而 Mojo 自己不含糊：`parseParametersIfPresent` 看見 `[` 就當
    // 參數表收下去，一次都不回頭。那句話在這一層就是「這個位置上方括號比列表緊」，
    // 所以 `prec(1)` 掛在這裏，不掛在 `type_parameters` 上——掛在那上面會連累它別
    // 的十幾處用法（尤其與 `origin_set` 爭 `[`）。
    _generator_parameters: ($) => prec(1, seq("[", optional(commaSepTrailing($.parameter)), "]")),

    generator_type: ($) =>
      prec.right(seq(
        "__generator_type",
        optional(field("type_parameters", alias($._generator_parameters, $.type_parameters))),
        field("body_type", $._expression),
      )),

    // ---- 記號 -------------------------------------------------------------

    identifier: (_) => /[_\p{XID_Start}][_\p{XID_Continue}]*/,

    // **反引號名字是一個普通名字，不是一種特別的表達式。** Mojo 的詞法器把
    // `` `C-3PO` `` 收成 `escaped_identifier`（`Lexer.cpp:445-478`），而
    // `parseIdentifier` 第一句就是 `consumeIf(Token::escaped_identifier)`
    // （`ParserBase.cpp:90`）——**凡是讀名字的地方都收得下它**，沒有例外。所以凡是
    // 語法裏寫 `$.identifier` 當「名字」的位置，一律改成這一條。
    // 語料裏這一族：模組路徑（`` import `dotted.pkg`.module ``）、結構名
    // （`` struct `weird()struct[]` ``）、參數名（`` def f(`C-3PO`: T) ``）、
    // import 進來的名字（`` from m import `use()weird[]` ``）。
    _name: ($) => choice($.identifier, $.backtick_identifier),

    // 反引號裏什麼都可以，點也可以——MLIR 的屬性名就是這麼寫的。
    backtick_identifier: (_) => token(seq("`", /[^`\n]*/, "`")),

    true: (_) => "True",
    false: (_) => "False",
    none: (_) => "None",
    ellipsis: (_) => "...",

    // 末尾的 `j`／`J` 是虛數字面量，同 Python。
    integer: (_) =>
      token(
        choice(
          /0[xX][0-9a-fA-F_]+/,
          /0[oO][0-7_]+/,
          /0[bB][01_]+/,
          /\d[\d_]*[jJ]?/,
        ),
      ),

    float: (_) =>
      token(
        choice(
          /\d[\d_]*\.\d[\d_]*([eE][+-]?\d+)?/,
          /\d[\d_]*\.([eE][+-]?\d+)?/,
          /\.\d[\d_]*([eE][+-]?\d+)?/,
          /\d[\d_]*[eE][+-]?\d+/,
        ),
      ),

    // **三引號先試。** 寫在前面纔不會被單引號那一支先吃掉開頭的兩個引號。
    // 前綴 `f`／`r`／`b` 以及它們的組合都收；f-string 裏的 `{…}` v0 不往裏解析，
    // 那是上色的事，等基線說它值得。
    string: (_) =>
      token(
        seq(
          // 前綴：`f` 格式、`r` 原始、`b` 字節，以及它們的組合。
          // Warning: **`t` 還留在這張表裏，而實際上收不到它。** t-string 歸外部掃描器
          // （`src/scanner.c` 的 `scan_t_string`），而外部記號在每一個表達式位置上都
          // 比內部詞法器先被問。留着它是一道網：萬一哪個狀態收得下 `string` 而收不下
          // `t_string`（`abi("…")` 那一格就是），一個 `t"…"` 落在那裏還有人認。
          optional(/[fFrRbBtT]{1,3}/),
          choice(
            // Warning: **沒有前瞻可用。** tree-sitter 的詞法是一臺 DFA，`(?!"")`
            // 它直接拒收。三引號的身體因此寫成四選一：不是引號的字符、轉義、
            // 一個引號後面跟非引號、兩個引號後面跟非引號——這樣閉合的那三個引號
            // 永遠配不進身體裏，而 `"` 和 `""` 在裏面照樣寫得出。
            seq('"""', repeat(choice(/[^"\\]/, /\\[\s\S]/, /"[^"]/, /""[^"]/)), '"""'),
            seq("'''", repeat(choice(/[^'\\]/, /\\[\s\S]/, /'[^']/, /''[^']/)), "'''"),
            seq('"', repeat(choice(/[^"\\\n]/, /\\[\s\S]/)), '"'),
            seq("'", repeat(choice(/[^'\\\n]/, /\\[\s\S]/)), "'"),
          ),
        ),
      ),

    // **挨着寫的字串literal 自己拼起來**，同 Python：`print("一行寫不完"\n " 接着寫")`。
    // 語料裏這一族是**最內層 ERROR 最大的一塊**（2026-10-10：2608 個失敗檔裏 280 個），
    // 因為長文案一律這麼折行。
    // Warning: **t-string 也拼得起來**：`String(t"{x}" t"{y}")` 出 `"1020"`
    // （`stdlib/test/format/test_tstring.mojo:374`）。相鄰字面量拼接是詞法那一層
    // 的事，前綴不影響它。
    concatenated_string: ($) =>
      seq(choice($.string, $.t_string), repeat1(choice($.string, $.t_string))),

    comment: (_) => token(seq("#", /[^\n]*/)),
  },
});

/** 逗號隔開的一串，至少一個，不許末尾多一個逗號。 */
function commaSep1(rule) {
  return seq(rule, repeat(seq(",", rule)));
}

/** 逗號隔開的一串，至少一個，末尾可以多一個逗號。 */
function commaSepTrailing(rule) {
  return seq(rule, repeat(seq(",", rule)), optional(","));
}

/** `a.b.c` 這種，用 `sep` 隔開。 */
function sep1(rule, separator) {
  return seq(rule, repeat(seq(separator, rule)));
}
