+++
title = "First Attempt on Writing a Clang Plugin"
date = "2023-04-13"
aliases = ["archives/first-attempt-on-clang-plugin"]
[taxonomies]
tags = ["LLVM", "Clang", "PostgreSQL"]
+++


*Updated on 2024/03/28: Recently, I learned a new tool called [CodeQL](https://codeql.github.com/). The AST matcher introduced in this post can be re-written into the following query.*

<details>
  <summary> suspicious-control-flow-stmt-in-PG_TRY.ql  (Click me to view the content)</summary>

```ql
/**
 * @name Find suspicious control flow stmt in PG_TRY()
 * @kind problem
 * @problem.severity warning
 * @id postgresql/suspicious-control-flow-stmt-in-pg-try
 */

import cpp

predicate pgTryCatchBlocks(Stmt tryBlock, Stmt catchBlock) {
  exists(IfStmt ifStmt, FunctionCall sigsetjmpCall, BinaryOperation op, Literal zero |
    sigsetjmpCall.getTarget().hasName("__sigsetjmp") and
    ifStmt.getCondition().(BinaryOperation) = op and
    op.getOperator() = "==" and
    op.hasOperands(sigsetjmpCall, zero) and
    /* Reduce false positives. */
    ifStmt.isAffectedByMacro() and
    tryBlock = ifStmt.getThen() and
    catchBlock = ifStmt.getElse()
  )
}

predicate suspiciousReturn(Stmt stmt) { stmt instanceof ReturnStmt }

predicate suspiciousBreak(Stmt stmt, Stmt tryBlock) {
  stmt instanceof BreakStmt and
  not exists(Loop loop |
    loop = tryBlock.getAChild+() and
    loop.getAChild+() = stmt
  ) and
  not exists(SwitchStmt switch |
    switch = tryBlock.getAChild+() and
    switch.getAChild+() = stmt
  )
}

predicate suspiciousContinue(Stmt stmt, Stmt tryBlock) {
  stmt instanceof ContinueStmt and
  not exists(Loop loop |
    loop = tryBlock.getAChild+() and
    loop.getAChild+() = stmt
  )
}

predicate suspiciousGoto(Stmt stmt, Stmt tryBlock) {
  stmt instanceof GotoStmt and
  not exists(LabelStmt label |
    label.getName() = stmt.(GotoStmt).getName() and
    label = tryBlock.getAChild+()
  )
}

from Stmt tryBlock, Stmt suspiciousControlFlowStmt
where
  pgTryCatchBlocks(tryBlock, _) and
  suspiciousControlFlowStmt = tryBlock.getAChild*() and
  (
    suspiciousReturn(suspiciousControlFlowStmt) or
    suspiciousBreak(suspiciousControlFlowStmt, tryBlock) or
    suspiciousContinue(suspiciousControlFlowStmt, tryBlock) or
    suspiciousGoto(suspiciousControlFlowStmt, tryBlock)
  )
select suspiciousControlFlowStmt, "Found suspicious control flow statements in PG_TRY() block"
```
</details>

*Updated on 2024/01/06: My fix got merged in [57d00517](https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=57d0051706b897048063acc14c2c3454200c488f) and I received a fancy PostgreSQL challenge coin!*

<img src="coin-1.jpg" width="280" style="display: inline-block" />  <img src="coin-2.jpg" width="280" style="display: inline-block"/>

My daily job is developing extensions for a database called [Greenplum](https://github.com/greenplum-db/gpdb). It's a distributed database derived from [PostgreSQL](https://www.postgresql.org/). Each time I play with it, I feel vigilant when encountering PostgreSQL error handling codes using `PG_TRY()`/`PG_CATCH()` blocks since we've seen many bugs caused by the misuse of it. I decide to write some automative tools to catch these bugs.

## What do PostgreSQL error handling codes look like?

Besides `PG_TRY()` and `PG_CATCH()`, there're 2 additional macros involved in the PostgreSQL error handling process: `ereport()` and `PG_END_TRY()`.

- `PG_TRY()`, `PG_CATCH()` and `PG_END_TRY()` is to construct the error handling control flow.
- `ereport()` is to report errors.

The code pattern of error handling process in PostgreSQL looks like,

```c
PG_TRY();
{
  // FallibleMethod() contains potential error reporting calls, e.g.,
  // ereport();
  FallibleMethod();
}
PG_CATCH();
{
  // Do error handling.
}
PG_END_TRY();
```

The code pattern of these macros looks very similar to `try-catch` expression in other languages, but their usage is more complicated. The definitions after being simplified for these macros are as follows,

```c
// I commented out the macro definition keyword, so that we can benefit
//   from the syntax highlighting :-)
// If you want to find the full definitions for these macros, you can find them
//   in the link below
//   https://github.com/postgres/postgres/blob/f7431bca8b0138bdbce7025871560d39119565a0/src/include/utils/elog.h#L384

// #define PG_TRY()
  do {
    sigjmp_buf *save_exception_stack = PG_exception_stack;
    sigjmp_buf local_sigjmp_buf;
    if (sigsetjmp(local_sigjmp_buf, 0) == 0)
    {
      PG_exception_stack = &local_sigjmp_buf

// #define PG_CATCH()
    }
    else
    {
      PG_exception_stack = save_exception_stack;

// #define PG_END_TRY()
    }
    PG_exception_stack = save_exception_stack;
  } while (0)
  
// #define ereport()
  if (PG_exception_stack != NULL)
    siglongjmp(*PG_exception_stack, 1);
  else
  {
    // In real world, we don't want this branch being taken.
    ...
  }
```

## How do `PG_TRY()` and `PG_CATCH()` work?

The global variable `sigjmp_buf *PG_exception_stack` saves the environment (stack context) of the previous `sigsetjmp()` call. Before entering the fallible code section (wrapped by `PG_TRY()` and `PG_CATCH()`), we use `sigjmp_buf *save_exception_stack` to save the previous environment and assign the current environment to `PG_exception_stack`, so that if any error occurs (call to `ereport()`), we can use `siglongjmp(*PG_exception_stack)` to jump to the correct location (catched by the correct `PG_CATCH()` block).

In the `PG_CATCH()` block, we restore the previous environment for `PG_exception_stack` before taking any error handling action, so that if we want to populate the error to the upper caller (call to `PG_RE_THROW()` which is another kind of wrapper for `siglongjmp()`), `siglongjmp(*PG_exception_stack)` can jump to the correct location again.

## The problem

One of the common mistakes being made is using jump statements (e.g., `return`, `break`, `continue` and `goto`) inside the `PG_TRY()` block, even for experienced PostgreSQL contributors[^1]. For example, if we use `return` statement inside the `PG_TRY()` block, the `PG_exception_stack` won't be restored to the correct stack context before we leaving the `PG_TRY()` block, this can lead severe issues to the PostgreSQL/Greenplum server, e.g., server crash[^2].

The code pattern we try to detect is the use of unsafe `return`, `break`, `continue` and `goto` statements inside the `PG_TRY()` block. The unsafe code pattern can be summarized to the following rules,

- `return` statements used in anywhere of the `PG_TRY()` block.

  ```c
  PG_TRY();
  {
    ...
    // Unsafe, since PG_exception_stack still stores the
    // current environment after leaving the PG_TRY-PG_CATCH
    // blocks.
    return;
  }
  PG_CATCH();
  {
    ...
  }
  PG_END_TRY();
  ```

- `break` statements used in anywhere of the `PG_TRY()` block except ones used inside the `switch`, `do-while`, `while` and `for` statements.

  ```c
  PG_TRY();
  {
    ...
    // Unsafe, since the break statement is jumping out of the 
    // the PG_TRY() block, which breaks the error handling
    // stack context or environment.
    break;
    do
    {
      // Safe, because we're jumping out of the do-while loop not the
      // PG_TRY() block.
      break;
    } while (0);
    while (1)
    {
      // Safe. Ditto.
      break;
    }
    for (;;)
    {
      // Safe. Ditto.
    }
    switch (c)
    {
    case 1:
      // Safe. Ditto.
      break;
    }
  }
  PG_CATCH();
  {
    ...
  }
  PG_END_TRY();
  ```

- `continue` statements used in anywhere of the `PG_TRY()` block except ones used inside the `do-while`, `while` and `for` loops.

  ```c
  PG_TRY();
  {
    // Unsafe, since the continue statement will terminate the do-while loop
    // expanded from the PG_TRY() macro and jump out of the PG_TRY() block
    // with broken error handing stack context.
    continue;
    do {
      // Safe.
      continue;
    } while (0);
    while (0)
    {
      // Safe.
      continue;
    }
    for (;;)
    {
      // Safe.
      continue;
    }
  }
  PG_CATCH();
  {
    ...
  }
  PG_END_TRY();
  ```

- `goto` statements with label out of the `PG_TRY()` block.

  ```c
  label1:
    PG_TRY();
    {
    label2:
      // Unsafe. Because we're jumping out of the PG_TRY() block and it
      // will break the stack context.
      goto label1;
      // Safe.
      goto label2;
    }
    PG_CATCH();
    {
      ...
    }
    PG_END_TRY();
  ```

## AST matcher or static analyzer?

The `PG_TRY()` is a macro in C and it's always expanded to the same thing. Besides, the statements we want to detect are very simple ones which don't involve tracking the change of symbols' states. Clang's AST matcher is good enough for our problem.

Firstly, we register a callback function `checkEndOfTranslationUnit()` to find out `PG_TRY()` blocks with `return`/`break`/`continue`/`goto` statements inside. The callback function will be called on each of translation unit during compiling. When a `PG_TRY()` block gets matched, we will carefully check if it's really unsafe to reduce false positive warnings. The code snippet with comments is listed below.

```cpp
class ReturnInPgTryBlockChecker : public Checker<check::EndOfTranslationUnit> {
public:
  void checkEndOfTranslationUnit(const TranslationUnitDecl *TU,
                                 AnalysisManager &AM, BugReporter &B) const {
    MatchFinder F;
    PgTryBlockMatcherCallback CB;
    StatementMatcher PgTry =
        // PG_TRY() will be expanded to the following expression.
        // if (__sigsetjmp() == 0) {
        //   PG_exception_stack = &local_sigjmp_buf;
        //   ...
        // }
        ifStmt(
            // The 'if' statement must contain a binary operator and the binary operator
            // must be '=='.
            hasCondition(
                binaryOperator(allOf(hasOperatorName("=="),
                                     // One of the '==' operands must be a function call and the
                                     // function must has name '__sigsetjmp'.
                                     // Another operand must be an integer literal '0'.
                                     hasOperands(callExpr(callee(functionDecl(
                                                     hasName("__sigsetjmp")))),
                                                 integerLiteral(equals(0)))))),
            // The 'if' statement must have a 'then' block and the 'then' block must
            // contain contain one of 'return', 'break', 'continue' and 'goto' statements.
            hasThen(eachOf(
                // For convenience, we bind the PG_TRY() block with return statement with
                // name 'ReturnInPgTryBlock', so that we can emit a warning message immediately
                // later.
                forEachDescendant(returnStmt().bind("ReturnInPgTryBlock")),
                anyOf(hasDescendant(breakStmt()), hasDescendant(continueStmt()),
                      hasDescendant(gotoStmt())))))
            // We bind our interested PG_TRY() block's AST to the name 'PgTryBlock' for careful
            // checking later.
            .bind("PgTryBlock");

    // &CB is the callback that will be invoked later for carefully checking the matched
    // PG_TRY() block's AST.
    F.addMatcher(PgTry, &CB);
    // Match the AST!
    F.matchAST(TU->getASTContext());
  }
};
```

Then, we check the matched `PG_TRY()` block's AST carefully. The following callback will be called once the AST bound to the name of `"ReturnInPgTryBlock"` or `"PgTryBlock"` gets matched.

```cpp
class PgTryBlockMatcherCallback : public MatchFinder::MatchCallback {
public:
  PgTryBlockMatcherCallback() = default;

  void run(const MatchFinder::MatchResult &Result) override {
    ASTContext *Ctx = Result.Context;

    if (const ReturnStmt *Return =
            Result.Nodes.getNodeAs<ReturnStmt>("ReturnInPgTryBlock")) {
      // We've found a return statement inside PG_TRY block. Let's warn about
      // it.
      DiagnosticsEngine &DE = Ctx->getDiagnostics();
      unsigned DiagID = DE.getCustomDiagID(
          DiagnosticsEngine::Error,
          "unsafe return statement is used inside PG_TRY block");
      auto DB = DE.Report(Return->getReturnLoc(), DiagID);
      DB.AddSourceRange(
          CharSourceRange::getCharRange(Return->getSourceRange()));
    } else if (const IfStmt *If =
                   Result.Nodes.getNodeAs<IfStmt>("PgTryBlock")) {
      // Check if the 'break'/'continue'/'goto' statements inside the
      // PG_TRY() black are unsafe.
      const Stmt *Then = If->getThen();
      CheckUnsafeBreakStmt(Then, Ctx);
      CheckUnsafeContinueStmt(Then, Ctx);
      CheckUnsafeGotoStmt(Then, Ctx);
    }
  }
};
```

The code for checking the safety of using `break`/`continue`/`goto` statements inside the `PG_TRY()` block are very similar. Here, we take `CheckUnsafeBreakStmt()` as an example. The basic idea behind it is performing BFS on the matched AST.

```cpp
static void CheckUnsafeBreakStmt(const Stmt *Then, ASTContext *Ctx) {
  std::queue<const Stmt *> StmtQueue;
  StmtQueue.push(Then);
  while (!StmtQueue.empty()) {
    const Stmt *CurrStmt = StmtQueue.front();
    StmtQueue.pop();

    if (!CurrStmt)
      continue;

    if (const BreakStmt *Break =
            llvm::dyn_cast_if_present<BreakStmt>(CurrStmt)) {
      // We've found a break statement inside PG_TRY block. Let's warn
      // about it.
      DiagnosticsEngine &DE = Ctx->getDiagnostics();
      unsigned DiagID = DE.getCustomDiagID(
          DiagnosticsEngine::Error,
          "break statement is used inside PG_TRY block which is unsafe");
      auto DB = DE.Report(Break->getBreakLoc(), DiagID);
      DB.AddSourceRange(CharSourceRange::getCharRange(Break->getSourceRange()));
    }

    // break stataments in while/do-while/for/switch statements are safe. We don't
    // need to perform BFS on the child nodes.
    if (llvm::isa<WhileStmt>(CurrStmt) || llvm::isa<DoStmt>(CurrStmt) ||
        llvm::isa<ForStmt>(CurrStmt) || llvm::isa<SwitchStmt>(CurrStmt)) {
      continue;
    }

    for (const Stmt *C : CurrStmt->children()) {
      StmtQueue.push(C);
    }
  }
}
```

Now, our checker can report unsafe code patterns in PostgreSQL based projects. The source code for the checker can be found in my GitHub repo[^3].

## Does it find any potential bugs in the real world?

Yes, it found! I found some unsafe codes with it in PostgreSQL[^1] and of course in Greenplum (I didn't file the issue to Greenplum since I would like to fix that in PostgreSQL first and cherry-pick the patch back to Greenplum). Some of interesting replies I get from the pgsql-hackers mailing list are as follows,

- Tom Lane mentions that using `break`/`continue`/`goto` inside the `PG_TRY()` block can also mess things up.
- Andres Freund gives a very cool compiler hacking with clang thread-safety-analysis. The patch seems better than my AST matcher idea. If his patch gets committed, we can reject such unsafe code patterns during compiling PostgreSQL.

```diff
From d1c99e9d12ba01adb21c5f17c792be44cfeef20f Mon Sep 17 00:00:00 2001
From: Andres Freund <andres@anarazel.de>
Date: Thu, 12 Jan 2023 21:18:55 -0800
Subject: [PATCH v1] wip: use clang anotations to warn if code in
 PG_TRY/CATCH/FINALLY returns

Only hooked up to meson right now.
---
 meson.build              |  1 +
 src/include/utils/elog.h | 43 +++++++++++++++++++++++++++++++++++++---
 2 files changed, 41 insertions(+), 3 deletions(-)

diff --git a/meson.build b/meson.build
index 45fb9dd616e..66a40e728f4 100644
--- a/meson.build
+++ b/meson.build
@@ -1741,6 +1741,7 @@ common_warning_flags = [
   '-Wimplicit-fallthrough=3',
   '-Wcast-function-type',
   '-Wshadow=compatible-local',
+  '-Wthread-safety',
   # This was included in -Wall/-Wformat in older GCC versions
   '-Wformat-security',
 ]
diff --git a/src/include/utils/elog.h b/src/include/utils/elog.h
index 4a9562fdaae..b211e08322a 100644
--- a/src/include/utils/elog.h
+++ b/src/include/utils/elog.h
@@ -381,32 +381,69 @@ extern PGDLLIMPORT ErrorContextCallback *error_context_stack;
  * same within each component macro of the given PG_TRY() statement.
  *----------
  */
+
+
+/*
+ * Annotations for detecting returns inside a PG_TRY(), using clang's thread
+ * safety annotations.
+ *
+ * The "lock" implementations need no_thread_safety_analysis as clang can't
+ * understand how a lock is implemented. We wouldn't want an implementation
+ * anyway, since there's no real lock here.
+ */
+#ifdef __clang__
+
+typedef int __attribute__((capability("no_returns_in_pg_try"))) no_returns_handle_t;
+
+static inline void no_returns_start(no_returns_handle_t l)
+	__attribute__((acquire_capability(l)))
+	__attribute__((no_thread_safety_analysis))
+{
+}
+
+static inline void no_returns_stop(no_returns_handle_t l)
+	__attribute__((release_capability(l)))
+	__attribute__((no_thread_safety_analysis))
+{}
+#else
+typedef int pg_attribute_unused() no_returns_handle_t;
+#define no_returns_start(t) (void)0
+#define no_returns_stop(t) (void)0
+#endif
+
 #define PG_TRY(...)  \
 	do { \
 		sigjmp_buf *_save_exception_stack##__VA_ARGS__ = PG_exception_stack; \
 		ErrorContextCallback *_save_context_stack##__VA_ARGS__ = error_context_stack; \
 		sigjmp_buf _local_sigjmp_buf##__VA_ARGS__; \
 		bool _do_rethrow##__VA_ARGS__ = false; \
+		no_returns_handle_t no_returns_handle##__VA_ARGS__ = 0; \
 		if (sigsetjmp(_local_sigjmp_buf##__VA_ARGS__, 0) == 0) \
 		{ \
-			PG_exception_stack = &_local_sigjmp_buf##__VA_ARGS__
+			PG_exception_stack = &_local_sigjmp_buf##__VA_ARGS__; \
+		    no_returns_start(no_returns_handle##__VA_ARGS__)
 
 #define PG_CATCH(...)	\
+			no_returns_stop(no_returns_handle##__VA_ARGS__); \
 		} \
 		else \
 		{ \
 			PG_exception_stack = _save_exception_stack##__VA_ARGS__; \
-			error_context_stack = _save_context_stack##__VA_ARGS__
+			error_context_stack = _save_context_stack##__VA_ARGS__; \
+		    no_returns_start(no_returns_handle##__VA_ARGS__)
 
 #define PG_FINALLY(...) \
+			no_returns_stop(no_returns_handle##__VA_ARGS__); \
 		} \
 		else \
 			_do_rethrow##__VA_ARGS__ = true; \
 		{ \
 			PG_exception_stack = _save_exception_stack##__VA_ARGS__; \
-			error_context_stack = _save_context_stack##__VA_ARGS__
+			error_context_stack = _save_context_stack##__VA_ARGS__; \
+		    no_returns_start(no_returns_handle##__VA_ARGS__)
 
 #define PG_END_TRY(...)  \
+			no_returns_stop(no_returns_handle##__VA_ARGS__); \
 		} \
 		if (_do_rethrow##__VA_ARGS__) \
 				PG_RE_THROW(); \
-- 
2.38.0
```

## What's the next step?

This is my very first attempt to write a Clang based checker. In addition to using unsafe `return`/`break`/`continue`/`goto` statements inside the `PG_TRY()` block, there're still some unsafe code patterns, e.g., modifying a local variable of auto storage class in the `PG_TRY()` block and use it in the `PG_CATCH()` block. It would be great to have more checkers for these unsafe code patterns in future.

[^1]: [https://www.postgresql.org/message-id/CACpMh+CMsGMRKFzFMm3bYTzQmMU5nfEEoEDU2apJcc4hid36AQ@mail.gmail.com](https://www.postgresql.org/message-id/CACpMh+CMsGMRKFzFMm3bYTzQmMU5nfEEoEDU2apJcc4hid36AQ@mail.gmail.com)
[^2]: [https://github.com/greenplum-db/gpdb/pull/14205](https://github.com/greenplum-db/gpdb/pull/14205)
[^3]: [https://github.com/higuoxing/clang-plugins/blob/88eeb2bea0ade224807bb3e35f1d048dd4d3697c/lib/ReturnInPgTryBlockChecker.cpp](https://github.com/higuoxing/clang-plugins/blob/88eeb2bea0ade224807bb3e35f1d048dd4d3697c/lib/ReturnInPgTryBlockChecker.cpp)
