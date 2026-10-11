// **縮進是掃描器的事，不是語法的事；t-string 也是。**
//
// Mojo 和 Python 一樣用縮進分塊，而「這一行比上一行深」不是一條正則說得出來的話：
// 它要記住外面每一層的深度。tree-sitter 給的辦法就是這一支——語法裏寫
// `$._newline`、`$._indent`、`$._dedent` 三個外部記號，由這裏在掃描的時候造出來。
//
// 第四個記號是 `$.t_string`，理由同一個：`t"A {t"B {val}"}"` 的身體要**數大括號的
// 層數**，而層數也不是正則數得出來的。tree-sitter 的內部詞法器是一臺 DFA，連
// `(?!"")` 這種前瞻都沒有。下面那幾支 `take_*` 是照 Mojo 自己的 `Lexer.cpp:528-915`
// 一句一句搬過來的（`skipStringBody`／`findTStringInterpolationEnd`／
// `skipTStringBody`／`lexTString`），差別只在一條：那邊能隨意回看 `ptr[1]`、`ptr[2]`，
// 這邊只看得見一個 `lookahead`，所以「看兩個字符再決定」一律改成「先收下來，不合就
// 當普通字符接着走」——逐例對過，落點與那邊逐字節相同（註釋寫在 `take_interpolation`
// 上面）。
//
// ---- 掃描器與 tree-sitter 之間的合約（照 `lib/src/lexer.c` 與 `lib/src/parser.c`
// 讀出來的，2026-10-10） -----------------------------------------------------
//
// 1. 每當解析器所在的狀態還有外部記號可收，這一支就在內部詞法器**之前**被叫到。
//    它說 `true`，內部詞法器那一輪根本不跑；說 `false`，位置退回原處重走內部那條。
// 2. `advance(lexer, true)`（下面的 `skip`）把位置往前挪，並且把
//    `token_start_position` 一起拖過去——跳掉的字符成了記號前面的空白，不是記號的
//    身體。`advance(lexer, false)` 則把它算進身體裏。
// 3. `mark_end(lexer)` 把 `token_end_position` 釘在當下這個位置；一次都不叫的話，
//    `ts_lexer_finish` 拿掃描器停下來的地方當結尾。
// 4. ⚠️ **下一個記號是從 `token_end_position` 開始掃的，不是從掃描器停下來的地方。**
//    這一條是整支掃描器的樞紐：一開頭就 `mark_end`，交出來的就是一個**寬度為零**的
//    記號，而前面那一串輸入原封不動留給下一次調用。一個換行要先收回三層再結束一句，
//    靠的就是這個——每一次調用都從同一個字節重新數一遍縮進，吐一個記號就走。
// 5. 寬度為零的外部記號，`ts_parser__lex` 在「序列化出來的掃描器狀態沒變」且
//    「正在錯誤恢復／這個記號是 extra／棧自上次出錯以來沒前進」時會**丟掉**它。
//    `INDENT`／`DEDENT` 動了縮進棧，狀態一定變，丟不掉；`NEWLINE` 不動棧，所以
//    語法裏**不許有「換行接着換行」那條路**，否則同一個字節上吐第二個 `NEWLINE`
//    要麽原地打轉、要麽被這一條靜靜丟掉。空行由下面那個循環一併跳過，不靠語法。
// 6. `valid_symbols` 說的是「當前狀態收得下什麽」，**錯誤恢復的時候幾乎全是真的**。
//    所以它只能當「可不可以」，不能當「是不是要」。
// 8. ⚠️ **`extras` 裏那幾條純字符的規則被折進了內部詞法器的同一輪掃描**
//    （生成出來的 `ts_lex` 裏那個 `SKIP(…)`）。所以空白**不會**讓外部掃描器被問第
//    二次：它只在跳之前那一個位置上被問到。凡是外部記號前面可能有空白、換行或註釋
//    的，跳白這件事就得由這一支自己做。
// 7. ⚠️ **`t_string` 是這裏唯一一個有寬度的記號**，所以第 4 條那個「一開頭就
//    `mark_end`」對它不成立：它要先把整個字面量收完，**最後**纔 `mark_end`。兩件事
//    因此有次序——`t_string` 那一支要跑在三個零寬記號之前，而它一旦說「眼前不是
//    t-string」就得原封不動交回去。交回去是免費的：第 1 條說掃描器回 `false` 位置
//    就退回原處（`ts_parser__lex` 裏那一句 `ts_lexer_reset`），所以那一支可以放心
//    先收幾個字符再反悔。
//
// ---- 第一版錯在哪（記下來，別再走回去） ------------------------------------
//
// 第一版交出 `NEWLINE` 的時候把換行**和下一行的縮進一起吃掉了**，於是下一次被叫到
// 的時候眼前沒有換行，那一支當場放棄——`DEDENT` 從來沒有真正交出來過，塊看着能收尾
// 只是因為檔尾那一支把棧裏的層都刷了。症狀是每一個「第二個子句與頭一個同深」的複合
// 語句全壞：`if/else`、`try/except`、`while/else`、`for/else` 裏那個 `else` 被當成
// 塊裏的一個標識符吞掉。`scanner-two-pass` 那個分支改成在換行**之後** `mark_end`、
// 下一趟從行首重數，方向對了一半而落點還是錯的（合約第 4 條：釘在換行之後，位置就
// 已經過了換行，多層收回照樣只收得了一層），而且 `if a:` 那一步要的是 `INDENT`，
// 它那一趟只認 `NEWLINE`，於是連進塊都進不去——基線從 15.75% 掉到 8.07%。
#include "tree_sitter/parser.h"

#include <stdlib.h>
#include <string.h>

enum TokenType {
  NEWLINE,
  INDENT,
  DEDENT,
  T_STRING,
};

// 縮進棧。`len` 是層數，`depth[0]` 永遠是 0（最外層）。
typedef struct {
  uint32_t len;
  uint32_t cap;
  uint16_t *depth;
} Scanner;

static void push(Scanner *s, uint16_t d) {
  if (s->len == s->cap) {
    s->cap = s->cap ? s->cap * 2 : 16;
    s->depth = realloc(s->depth, s->cap * sizeof(uint16_t));
  }
  s->depth[s->len++] = d;
}

void *tree_sitter_mojo_external_scanner_create(void) {
  Scanner *s = calloc(1, sizeof(Scanner));
  push(s, 0);
  return s;
}

void tree_sitter_mojo_external_scanner_destroy(void *payload) {
  Scanner *s = payload;
  free(s->depth);
  free(s);
}

// Warning: **序列化的是棧本身，不是指針。** tree-sitter 會把掃描器的狀態存下來再
// 還原（增量重算、錯誤恢復都用），所以這兩支要能把全部狀態寫進一塊字節裏。
// 合約第 5 條還靠它：這塊字節變了沒變，決定一個寬度為零的記號留不留得住。
unsigned tree_sitter_mojo_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = payload;
  uint32_t n = s->len;
  if (n * sizeof(uint16_t) > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
    n = TREE_SITTER_SERIALIZATION_BUFFER_SIZE / sizeof(uint16_t);
  }
  memcpy(buffer, s->depth, n * sizeof(uint16_t));
  return n * sizeof(uint16_t);
}

void tree_sitter_mojo_external_scanner_deserialize(void *payload, const char *buffer,
                                                   unsigned length) {
  Scanner *s = payload;
  s->len = 0;
  if (length == 0) {
    push(s, 0);
    return;
  }
  uint32_t n = length / sizeof(uint16_t);
  for (uint32_t i = 0; i < n; i++) {
    uint16_t d;
    memcpy(&d, buffer + i * sizeof(uint16_t), sizeof(uint16_t));
    push(s, d);
  }
}

static void skip(TSLexer *lexer) { lexer->advance(lexer, true); }
static void take(TSLexer *lexer) { lexer->advance(lexer, false); }

// ---- t-string ---------------------------------------------------------------
//
// 一個 t-string 是**一個記號**，從 `t"` 一路收到配對的那個引號——中間的 `{…}` 裏可以
// 有字串，字串裏可以再有 t-string。Mojo 那邊的上限是二十層（`Lexer.cpp:759` 那句
// `assert`），這裏照抄。

static bool is_quote(int32_t c) { return c == '"' || c == '\''; }
static bool is_t(int32_t c) { return c == 't' || c == 'T'; }
static bool is_r(int32_t c) { return c == 'r' || c == 'R'; }

#define T_STRING_MAX_DEPTH 20

// 收開頭那一串引號。進來的時候 `lookahead` 就是那個引號。
// 回 `false` 的那一種是 `t""`／`t''`——兩個引號，字面量**當場就完了**，身體不用收。
static bool take_quote_opening(TSLexer *lexer, int32_t quote, bool *triple) {
  take(lexer);
  *triple = false;
  if (lexer->lookahead != quote) return true;
  take(lexer);
  if (lexer->lookahead != quote) return false;
  take(lexer);
  *triple = true;
  return true;
}

// 收一個**普通**字串的身體（`Lexer.cpp:528` 的 `skipStringBody`）。
// Warning: 原始字串裏的反斜線照樣算轉義——那一支就是這麼寫的，它只負責跳過去，
// 不負責解釋。
static void take_string_body(TSLexer *lexer, int32_t quote, bool triple) {
  for (;;) {
    if (lexer->eof(lexer)) return;
    if (lexer->lookahead == '\\') {
      take(lexer);
      if (!lexer->eof(lexer)) take(lexer);
      continue;
    }
    if (lexer->lookahead == quote) {
      take(lexer);
      if (!triple) return;
      if (lexer->lookahead != quote) continue;
      take(lexer);
      if (lexer->lookahead != quote) continue;
      take(lexer);
      return;
    }
    take(lexer);
  }
}

static bool take_t_string_body(TSLexer *lexer, int32_t quote, bool triple,
                               unsigned depth);

// 一段 `{…}`。**進來的時候開頭那個 `{` 已經收掉了**（`{{` 轉義要看兩個字符纔分得出，
// 而這裏只有一個 `lookahead`，所以由呼叫方先收一個再看）。
//
// Warning: **「看兩個字符再決定」一律改成「先收，不合就當普通字符」，而落點不變。**
// 舉 `rtt"x"` 當例：Mojo 那邊在 `r` 上試 `rt`＋引號（第三個是 `t`，不合）、再試
// `r`＋引號（不合），`ptr++`；到第一個 `t` 上同樣兩試皆不合，`ptr++`；到第二個 `t`
// 纔配上 `t"`。這邊是 `r` 收下、看見 `t` 收下、第三個不是引號就接着走——同樣停在第二
// 個 `t` 上，同樣在那裏配上 `t"`。`rr"x"`、`trx` 幾種也逐一對過，一樣。
static bool take_interpolation(TSLexer *lexer, unsigned depth) {
  if (depth > T_STRING_MAX_DEPTH) return false;
  int brace = 1;
  while (brace > 0) {
    if (lexer->eof(lexer)) return false;
    int32_t c = lexer->lookahead;
    if (c == '{') {
      brace++;
      take(lexer);
    } else if (c == '}') {
      brace--;
      take(lexer);
    } else if (c == '\\') {
      take(lexer);
      if (!lexer->eof(lexer)) take(lexer);
    } else if (is_quote(c)) {
      bool triple;
      if (take_quote_opening(lexer, c, &triple)) take_string_body(lexer, c, triple);
    } else if (is_r(c) || is_t(c)) {
      // `t"`／`rt"`／`tr"` 開一個嵌套的 t-string；`r"` 開一個原始字串；
      // 都配不上的話剛收下的那一兩個字符就是普通字符。
      bool saw_t = is_t(c);
      bool saw_r = is_r(c);
      take(lexer);
      if ((saw_r && is_t(lexer->lookahead)) || (saw_t && is_r(lexer->lookahead))) {
        saw_t = saw_r = true;
        take(lexer);
      }
      if (is_quote(lexer->lookahead)) {
        int32_t q = lexer->lookahead;
        bool triple;
        bool open = take_quote_opening(lexer, q, &triple);
        if (saw_t) {
          if (open && !take_t_string_body(lexer, q, triple, depth + 1)) return false;
        } else if (open) {
          take_string_body(lexer, q, triple);
        }
      }
    } else {
      take(lexer);
    }
  }
  return true;
}

// 一個 t-string 的身體（`Lexer.cpp:841` 的 `skipTStringBody`）。
static bool take_t_string_body(TSLexer *lexer, int32_t quote, bool triple,
                               unsigned depth) {
  for (;;) {
    if (lexer->eof(lexer)) return false;
    int32_t c = lexer->lookahead;
    if (c == '{') {
      take(lexer);
      if (lexer->lookahead == '{') {
        take(lexer);
        continue;
      }
      if (!take_interpolation(lexer, depth)) return false;
      continue;
    }
    if (c == '}') {
      take(lexer);
      if (lexer->lookahead == '}') take(lexer);
      continue;
    }
    if (c == '\\') {
      take(lexer);
      if (!lexer->eof(lexer)) take(lexer);
      continue;
    }
    if (c == quote) {
      take(lexer);
      if (!triple) return true;
      if (lexer->lookahead != quote) continue;
      take(lexer);
      if (lexer->lookahead != quote) continue;
      take(lexer);
      return true;
    }
    if ((c == '\n' || c == '\r') && !triple) {
      // 單引號的字面區裏換行＝沒收尾（`Lexer.cpp:883`）。
      return false;
    }
    take(lexer);
  }
}

// Warning: **前綴只有 `t`／`T`／`rt`／`tr` 那幾種**（`Lexer.cpp:261-272`）——`ft"` 不是
// t-string。收不成就回 `false`，位置自己退回去（合約第 7 條）。
static bool scan_t_string(TSLexer *lexer) {
  int32_t c = lexer->lookahead;
  if (!is_r(c) && !is_t(c)) return false;
  take(lexer);
  if (is_r(c)) {
    if (!is_t(lexer->lookahead)) return false;
    take(lexer);
  } else if (is_r(lexer->lookahead)) {
    take(lexer);
  }
  if (!is_quote(lexer->lookahead)) return false;

  int32_t quote = lexer->lookahead;
  bool triple;
  if (take_quote_opening(lexer, quote, &triple) &&
      !take_t_string_body(lexer, quote, triple, 1)) {
    return false;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = T_STRING;
  return true;
}

bool tree_sitter_mojo_external_scanner_scan(void *payload, TSLexer *lexer,
                                            const bool *valid_symbols) {
  Scanner *s = payload;

  // ⚠️ **空白要由這一支自己跳過去，不能指望 `extras`。** 合約第 8 條：生成出來的
  // 內部詞法器把 `extras` 裏那幾條純字符的規則**折進了同一輪掃描**（`SKIP(…)`），
  // 所以「跳掉空白之後再問一次外部掃描器」這件事根本不發生——外部掃描器只在**跳之前**
  // 那個位置上被問到一次。t-string 因此必須與縮進那一段共用同一個跳白循環：先讓那三
  // 個零寬記號有機會發，發不出來纔在**跳完的那個位置**上試 t-string。
  // 2026-10-11 就是這麼查出來的：`f(\n    t"a{"b"}"\n)` 裏那個 t-string 被內部詞法器
  // 當成兩個普通字串收了（`t"a{` ＋ `b"}"`），**而且不出 ERROR**——兩個相鄰字串自己
  // 拼成了一個 `concatenated_string`。要驗這一族只能看節點類型，不能只看紅綠。
  bool want_zero = valid_symbols[NEWLINE] || valid_symbols[INDENT] || valid_symbols[DEDENT];
  bool want_tstring = valid_symbols[T_STRING];
  if (!want_zero && !want_tstring) {
    return false;
  }

  // ⚠️ **第一句就把結尾釘在這裏**，三個記號因此都是寬度為零的，位置一步也不動。
  // 合約第 4 條：下面那一串 `skip` 讀過去的輸入，下一次調用照樣看得見。
  lexer->mark_end(lexer);

  // 走到下一個真有內容的行的行首，一路數出它的深度。
  //
  // Warning: **空行和整行註釋不算縮進。** 它們的「深度」是偶然的（一個空行可能一個
  // 空格都沒有），照它收層會把下面的塊整個拆掉。掃到它們就跳過，當這一行不存在。
  bool saw_newline = false;
  uint16_t depth = 0;
  int32_t first_comment_depth = -1;
  for (;;) {
    if (lexer->lookahead == '\n') {
      saw_newline = true;
      depth = 0;
      skip(lexer);
    } else if (lexer->lookahead == '\r' || lexer->lookahead == '\f') {
      depth = 0;
      skip(lexer);
    } else if (lexer->lookahead == ' ') {
      depth++;
      skip(lexer);
    } else if (lexer->lookahead == '\t') {
      // 一個製表符進到下一個八的倍數——Python 的算法，Mojo 的縮進也是這麼數的。
      depth = (depth / 8 + 1) * 8;
      skip(lexer);
    } else if (lexer->lookahead == '\\') {
      // 續行：反斜線加換行，這一行還沒完，所以 `saw_newline` 不動。
      // Warning: 後面不是換行的反斜線**不許吃**——那是別人的記號。
      skip(lexer);
      if (lexer->lookahead == '\r') skip(lexer);
      if (lexer->lookahead == '\n') {
        skip(lexer);
      } else if (!lexer->eof(lexer)) {
        return false;
      }
    } else if (lexer->lookahead == '#') {
      // 行尾的註釋（`x = 1  # 說明`）不是整行註釋：這裏還沒換過行，一句還沒結束，
      // 讓給 `extras` 去收，下一次調用纔輪到換行。
      // Warning: **只有 t-string 在等的時候那句話不成立**——那時三個零寬記號一個都發
      // 不出來，於是「下一次調用」不會來（見上面第 8 條），這個註釋就得在這裏跳掉。
      if (!saw_newline) {
        if (want_zero) return false;
        while (!lexer->eof(lexer) && lexer->lookahead != '\n') skip(lexer);
        continue;
      }
      if (first_comment_depth < 0) first_comment_depth = (int32_t)depth;
      while (!lexer->eof(lexer) && lexer->lookahead != '\n') skip(lexer);
    } else if (lexer->eof(lexer)) {
      // **檔尾算一個行尾。** 不算的話最後一句少一個結束記號（最後一行沒有換行符的
      // 檔就是這樣），而棧裏那幾層也永遠收不回來，整棵樹是錯的。
      saw_newline = true;
      depth = 0;
      break;
    } else {
      break;
    }
  }

  if (!saw_newline) {
    // 同一行裏往前走的那一種：沒有行尾，三個零寬記號都不該發。
    return want_tstring ? scan_t_string(lexer) : false;
  }

  // Warning: **順序是 INDENT → DEDENT → NEWLINE。** 一行同時是「上一句結束」和
  // 「進了一層」，而語法要先拿到那個結束；反過來交，塊的第一句會掛在外面那一層。
  uint16_t here = s->depth[s->len - 1];
  if (valid_symbols[INDENT] && depth > here) {
    push(s, depth);
    lexer->result_symbol = INDENT;
    return true;
  }
  if (valid_symbols[DEDENT] && depth < here && s->len > 1 &&
      // 塊尾那幾行與塊同深的註釋，等它們被收進塊裏再收層——否則註釋會掉到外面
      // 那一層去。不是正確性問題（兩種都不出 ERROR），是樹的形狀問題。
      first_comment_depth < (int32_t)here) {
    s->len--;
    lexer->result_symbol = DEDENT;
    return true;
  }
  // ⚠️ **比這一句深的下一行是這一句的續行，不是新的一句。** Mojo 的判準就一行：
  // `tokIndent > stmtIndent`（`ParserBase.h:198-211` 的 `isTokenInCurrentStatement`）
  // ——換行**不結束**一句，「下一行退回到這一句的深度或更淺」纔結束。語料裏這一族的
  // 樣子（每一條都真有）：
  //
  //     def foldable_requires_1[x: Int]()
  //         where x:                          # where 折到下一行
  //     def parametricMut[o: Origin](a: T)
  //        -> Pointer[MemExample, o]._mlir_lit_ref:   # 返回類型折到下一行
  //     var rebind = __mlir_op.`kgen.rebind`
  //         [_type=Pointer[Int, origin_of(s.b)]._mlir_lit_ref](litref)   # 下標折行
  //
  // 走到這裏 `depth > here` 就一定是續行：上面那一條 `INDENT` 已經把「這是一個塊的
  // 開頭」那一種接走了（冒號後面纔收得下 `INDENT`），所以剩下的只有續行。
  // Warning: **這一條取消了語法裏原本那個取捨。** 從前「折行的 `where`」與「trait 裏
  // 無體的方法」在語法那一層撞（兩者都要在簽名後面收一個換行），於是只留了後者。
  // 搬到掃描器之後兩件事不再爭：無體方法的下一行與它同深，續行的下一行比它深。
  if (valid_symbols[NEWLINE] && depth <= here) {
    lexer->result_symbol = NEWLINE;
    return true;
  }
  // 三個零寬記號一個都發不出來——那這個換行是括號裏的隱式續行，只是空白。
  // 空白已經跳完了，眼前就是下一個真記號：試試它是不是一個 t-string。
  return want_tstring ? scan_t_string(lexer) : false;
}
