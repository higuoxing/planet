+++
title = "Implementing an alternative JIT provider for PostgreSQL"
date = "2023-10-09"
[taxonomies]
tags = ["JIT", "PostgreSQL", "LLVM"]
+++

Just in time compilation is added to PostgreSQL since the version of 11. The default JIT provider for PostgreSQL is based on LLVM. PostgreSQL allows user to use an alternative JIT provider by setting the `jit_provider` GUC parameter[^1]. The pluggable JIT interface is very easy to use and I've successfully built two prototypes, one emits C codes[^2] and the other one emits assembly codes[^3] using the AsmJit library[^4]. In this post, I'll give a brief introduction to the existing LLVM JIT provider and show you how to implement the prototype that emits C codes. It's fun and easy.

## Introduction to the LLVM JIT provider

### Enable the LLVM JIT

The builtin JIT provider can be enabled by appending `--with-llvm` to configuration flags when building PostgreSQL. If you have multiple LLVM toolchains installed on your system, you may need to specify the `CLANG` and `LLVM_CONFIG` environment variable to make sure they are from the same LLVM toolchain set. Otherwise, there will be ABI incompatible issues.

```bash
CC=/<path>/<to>/clang CXX=/<path>/<to>/clang++ CLANG=/<path>/<to>/clang LLVM_CONFIG=/<path>/<to>/llvm-config \
  ./configure --with-llvm <other-configure-flags>
```

After building it, type the following commands to verify that the LLVM JIT is enabled in your server.

```sql
postgres=# SHOW jit;
 jit
-----
 on
(1 row)

postgres=# SHOW jit_provider;
 jit_provider
--------------
 llvmjit
(1 row)

```

Setting `jit_above_cost` to `0` to force the server to jit the query.

```sql
postgres=# SET jit_above_cost=0;
SET
postgres=# EXPLAIN (ANALYZE) SELECT 1;
                                                 QUERY PLAN
------------------------------------------------------------------------------------------------------------
 Result  (cost=0.00..0.01 rows=1 width=4) (actual time=3.945..3.946 rows=1 loops=1)
 Planning Time: 0.039 ms
 JIT:
   Functions: 1
   Options: Inlining false, Optimization false, Expressions true, Deforming true
   Timing: Generation 0.181 ms, Inlining 0.000 ms, Optimization 0.216 ms, Emission 3.721 ms, Total 4.117 ms
 Execution Time: 4.218 ms
(7 rows)
```

From the JIT statistics, we learned that the LLVM JIT supports accelerating queries from various aspects, e.g., inlining functions, jitting expressions and jitting the tuple deforming process.

### Jitting expressions

In PostgreSQL, expressions in SQL queries are finally converted to low level operators and their results can be computed via interpreting these operators. Those operators are defined in the header file [`src/include/executor/execExpr.h`](https://github.com/postgres/postgres/blob/526fe0d79914b2dfcfd79effd1ab26ff62469248/src/include/executor/execExpr.h#L65).

```c
typedef enum ExprEvalOp
{
  /* entire expression has been evaluated completely, return */
  EEOP_DONE,

  /* apply slot_getsomeattrs on corresponding tuple slot */
  EEOP_INNER_FETCHSOME,
  EEOP_OUTER_FETCHSOME,
  EEOP_SCAN_FETCHSOME,
  ...
};
```

When the JIT is not enabled, the main entry for interpreting them is [`src/backend/executor/execExprInterp.c:ExecInterpExpr`](https://github.com/postgres/postgres/blob/526fe0d79914b2dfcfd79effd1ab26ff62469248/src/backend/executor/execExprInterp.c#L395) and the result of the expression can be computed by iterating over the [`ExprState::steps`](https://github.com/postgres/postgres/blob/526fe0d79914b2dfcfd79effd1ab26ff62469248/src/backend/executor/execExprInterp.c#L515) array.

```c
/*
 * ExecInterpExpr is using "direct-threaded" implementation of expression evaluation
 * to improve the performance. In order to make the interpreter easy to understand,
 * I re-write it using a for-loop.
 */
static Datum
ExecInterpExpr(ExprState *state, ExprContext *econtext, bool *isnull)
{
	...
	for (int opno = 0; opno < state->steps_len; ++opno)
	{
		ExprEvalStep *op = &state->steps[opno];
		switch ((ExprEvalOp) op->opcode)
		{
		case EEOP_DONE:
		{
			*isnull = state->resnull;
			return state->resvalue;
		}
		case EEOP_INNER_FETCHSOME:
		{
			CheckOpSlotCompatibility(op, innerslot);
			slot_getsomeattrs(innerslot, op->d.fetch.last_var);
			break;
		}
		/* Other operators... */
		}
	}
	...
}
```

When the LLVM JIT is enabled, before interpreting operators, the LLVM JIT provider will compile these operators into the LLVM IR and the main entry for compiling operators is [`src/backend/jit/llvm/llvmjit_expr.c:llvm_compile_expr`](https://github.com/postgres/postgres/blob/526fe0d79914b2dfcfd79effd1ab26ff62469248/src/backend/jit/llvm/llvmjit_expr.c#L78).

```c
bool
llvm_compile_expr(ExprState *state)
{
	/*
	 * Emit a function that has similar signature with
	 * Datum ExecInterpExpr(ExprState *state, ExprContext *econtext, bool *isnull).
	 *
	 * NOTE: LLVM never has such API, it's for easy understanding!
	 */
	Func = LLVMIRBuilder.newFunc("Datum JittedExecInterpExpr(ExprState *, ExprContext *, bool *)");
	for (int opno = 0; opno < state->steps_len; ++op)
	{
		switch ((ExprEvalOp) op->opcode)
		{
		case EEOP_DONE:
		{
			/* Emit LLVM IR for the EEOP_DONE operator */
			Func.emit("Assign state->resnull to *isnull");
			Func.emit("Return state->resvalue");
			break;
		}
		/* Emit LLVM IR for other operators... */
		}
	}
	...
	/*
	 * Add the emitted function to the LLVM JIT runtime.
	 * EmittedFunc is the address that the jitted function emitted to.
	 */
	EmittedFunc = LLVMRuntime.add(Func);
	...
	/*
	 * Store the emitted function's address to state->evalfunc so that the
	 * caller will invoke the jitted function.
	 */
	state->evalfunc = EmittedFunc;
	...
}
```

### Jitting the tuple deforming process

The tuple deforming process is invoked in 3 operators: `EEOP_INNER_FETCHSOME`, `EEOP_OUTER_FETCHSOME` and `EEOP_SCAN_FETCHSOME`. That is to say, if we add the code generation support for these 3 operators then jitting the tuple deforming is supported.

### Inlining functions

If we install the PostgreSQL server with LLVM JIT support, there's a special directory `<prefix>/lib/postgresql/bitcode/`.

```bash
$ ls -al <prefix>/lib/postgresql/bitcode/
total 2068
drwxr-xr-x  3 v users    4096 Nov  6 23:24 .
drwxr-xr-x  4 v users    4096 Nov  5 09:03 ..
drwxr-xr-x 28 v users    4096 Oct 22 10:22 postgres
-rw-r--r--  1 v users 2104036 Nov  1 21:25 postgres.index.bc
```

It contains the LLVM bitcodes of the whole server. When the jitted expression is invoking other functions, the server process will look up the function definition from bitcodes. If the function is able to be inlined, that function will be extracted from bitcodes and be placed in the jitted function body. Our prototype will not support inlining functions since I haven't been able to find a way to implement it without LLVM.

## Implement our own JIT provider prototype

From the above analysis, even if we are not experts of the executor, we are still able to implement an alternative JIT provider for PostgreSQL. Since the emitted function is identical to [`src/backend/executor/execExprInterp.c:ExecInterpExpr`](https://github.com/postgres/postgres/blob/526fe0d79914b2dfcfd79effd1ab26ff62469248/src/backend/executor/execExprInterp.c#L395).

### The pluggable JIT interface

PostgreSQL provides interfaces for implementing JIT providers.

```cc
struct JitProviderCallbacks
{
  // For compiling operators to machine codes.
  JitProviderCompileExprCB compile_expr;
  // For releasing resources after finishing executing the jitted codes.
  JitProviderReleaseContextCB release_context;
  // For reset some states when there're errors occurred either during
  // compiling operators or executing jitted codes.
  JitProviderResetAfterErrorCB reset_after_error;
};

extern void _PG_jit_provider_init(JitProviderCallbacks *cb);
```

Now, we've got basic knowledges about PostgreSQL's JIT provider. Let's get started!

### Basic setup for `pg_slowjit`

We will implement our JIT provider as an extension, since PostgreSQL's extension building framework[^5] is very handy to use. Let's create a directory `pg_slowjit` with 3 files in it: `Makefile`, `slowjit.control` and `slowjit.c`

<details>
  <summary> pg_slowjit/Makefile  (Click me to view the content)</summary>
  
  ```makefile
  MODULE_big = slowjit
  EXTENSION = slowjit

  OBJS = slowjit.o

  # Disable LLVM bitcodes generation.
  override with_llvm = no

  PG_CONFIG := pg_config
  PGXS := $(shell $(PG_CONFIG) --pgxs)
  include $(PGXS)
  ```
</details>

<details>
  <summary> pg_slowjit/slowjit.control  (Click me to view the content)</summary>

  ```text
  comment = 'A very inefficient jit provider.'
  default_version = '1.0.0'
  module_pathname = '$libdir/slowjit'
  relocatable = true
  ```
</details>

<details>
  <summary> pg_slowjit/slowjit.c  (Click me to view the content)</summary>

  ```c
  /* A bunch of header files. */
  #include "postgres.h"

  #include "c.h"
  #include "executor/execExpr.h"
  #include "fmgr.h"
  #include "jit/jit.h"
  #include "lib/stringinfo.h"
  #include "miscadmin.h"
  #include "nodes/execnodes.h"
  #include "nodes/pg_list.h"
  #include "pg_config_manual.h"
  #include "utils/elog.h"
  #include "utils/memutils.h"
  #include "utils/palloc.h"
  #include "utils/resowner.h"
  #include "utils/resowner_private.h"

  #include <dlfcn.h>
  #include <stdbool.h>
  #include <stdint.h>
  #include <stdio.h>
  #include <stdlib.h>

  PG_MODULE_MAGIC;

  extern void _PG_jit_provider_init(JitProviderCallbacks *cb);

  /* Function prototypes for JIT compilation. */
  static bool slowjit_compile_expr(ExprState *state) {
    /*
	 * Emit a notice message so that we can check if the JIT provider being
	 * loaded successfully.
	 */
    elog(NOTICE, "slowjit_compile_expr");
    /* Returning 'false' indicates we won't jit the current expression. */
    return false;
  }
  static void slowjit_release_context(JitContext *ctx) {
    elog(NOTICE, "slowjit_release_context");
  }
  static void slowjit_reset_after_error(void) {
    elog(NOTICE, "slowjit_reset_after_error");
  }

  /* Function where we initialize JIT compilation callbacks. */
  void _PG_jit_provider_init(JitProviderCallbacks *cb) {
    cb->compile_expr = slowjit_compile_expr;
    cb->release_context = slowjit_release_context;
    cb->reset_after_error = slowjit_reset_after_error;
  }
  ```
</details>

Test that we are able to compile our extension.

```bash
$ make PG_CONFIG=/<path>/<to>/pg_config install
```

Make sure that PostgreSQL can load our JIT provider.

1. Edit `/<path>/<to>/<DataDir>/postgresql.conf` and add following lines.

   ```diff
   + jit_provider='slowjit' # Tell PostgreSQL to use our JIT provider
   + jit_above_cost=0       # Force the PostgreSQL to jit expressions
   ```

2. Restart the PostgreSQL server.

   ```bash
   $ pg_ctl -D <path>/<to>/<DataDir> -l <path>/<to>/logfile restart
   ```
   
3. Open the `psql` client.

   ```sql
   postgres=# EXPLAIN SELECT 1;
   NOTICE:  slowjit_compile_expr
                   QUERY PLAN
   ------------------------------------------
    Result  (cost=0.00..0.01 rows=1 width=4)
   (1 row)
   ```

You'll find that the NOTICE message is printed out to our terminal. Our JIT provider has been successfully loaded! 🎉

### Context management for `pg_slowjit`

You may have noticed that there's a special data structure called `JitContext`, it tracks allocated resources and records essential information of the current JIT compilation. `JitContext::flags` controls whether to jit the tuple deforming process (`flags & PGJIT_DEFORM`), whether to optimize jitted codes aggressively (`flags & PGJIT_OPT3`), etc. `JitContext::resowner` records the current resource owner. `JitContext::instr` records some statistics about the current jitted query, e.g., time consumed in the tuple deforming process, code optimization, function inlining, etc.

```c
typedef struct JitContext
{
  int flags;
  ResourceOwner resowner;
  JitInstrumentation instr;
} JitContext;
```

Different JIT providers can have different resources to track and we can inherit the `JitContext` for `SlowJitContext`.

```c
typedef struct SlowJitContext {
  JitContext base;
  /* Fields to be implemented later. */
} SlowJitContext;
```

The callback function `cb->compile_expr` can be called multiple times for a single query. The `JitContext` data structure gets initialized when the `cb->compile_expr` gets called for the first time. Now, let's initialize our `SlowJitContext`.

<details>
  <summary> pg_slowjit/slowjit.c  (Click me to view the diff)</summary>

```diff
 /* A bunch of header files. */
 #include "postgres.h"

 #include "c.h"
 #include "executor/execExpr.h"
 #include "fmgr.h"
 #include "jit/jit.h"
 #include "lib/stringinfo.h"
 #include "miscadmin.h"
 #include "nodes/execnodes.h"
 #include "nodes/pg_list.h"
 #include "pg_config_manual.h"
 #include "utils/elog.h"
 #include "utils/memutils.h"
 #include "utils/palloc.h"
 #include "utils/resowner.h"
 #include "utils/resowner_private.h"

 #include <dlfcn.h>
 #include <stdbool.h>
 #include <stdint.h>
 #include <stdio.h>
 #include <stdlib.h>

 PG_MODULE_MAGIC;

 extern void _PG_jit_provider_init(JitProviderCallbacks *cb);

+ typedef struct SlowJitContext {
+   JitContext base;
+   /* Fields to be implemented later. */
+ } SlowJitContext;
+
 /* Function prototypes for JIT compilation. */
 static bool slowjit_compile_expr(ExprState *state) {
+  PlanState *parent = state->parent;
+  SlowJitContext *jit_ctx = NULL;
+
+  /* parent shouldn't be NULL. */
+  Assert(parent != NULL);
+
   /*
 	 * Emit a notice message so that we can check if the JIT provider being
 	 * loaded successfully.
 	 */
   elog(NOTICE, "slowjit_compile_expr");

+  /* Initialize the context. */
+  if (parent->state->es_jit) {
+    /*
+     * We can reuse the JIT context.
+     */
+    jit_ctx = (SlowJitContext *)parent->state->es_jit;
+  } else {
+    ResourceOwnerEnlargeJIT(CurrentResourceOwner);
+
+    jit_ctx = (SlowJitContext *)MemoryContextAllocZero(TopMemoryContext,
+                                                       sizeof(SlowJitContext));
+    jit_ctx->base.flags = parent->state->es_jit_flags;
+
+    /* ensure cleanup */
+    jit_ctx->base.resowner = CurrentResourceOwner;
+    ResourceOwnerRememberJIT(CurrentResourceOwner, PointerGetDatum(jit_ctx));
+
+    /* For re-using the JIT context. */
+    parent->state->es_jit = &jit_ctx->base;
+  }

   /* Returning 'false' indicates we won't jit the current expression. */
   return false;
 }
 static void slowjit_release_context(JitContext *ctx) {
   elog(NOTICE, "slowjit_release_context");
 }
 static void slowjit_reset_after_error(void) {
   elog(NOTICE, "slowjit_reset_after_error");
 }

 /* Function where we initialize JIT compilation callbacks. */
 void _PG_jit_provider_init(JitProviderCallbacks *cb) {
   cb->compile_expr = slowjit_compile_expr;
   cb->release_context = slowjit_release_context;
   cb->reset_after_error = slowjit_reset_after_error;
 }
```
</details>

Re-compile our JIT provider by

```bash
$ make PG_CONFIG=/<path>/<to>/pg_config install
```

Re-run the query and you'll find that `slowjit_release_context` gets called! That is to say, resources being tracked in `SlowJitContext` can be released in `slowjit_release_context`.

```sql
postgres=# EXPLAIN SELECT 1;
NOTICE:  slowjit_compile_expr
NOTICE:  slowjit_release_context
                QUERY PLAN
------------------------------------------
 Result  (cost=0.00..0.01 rows=1 width=4)
(1 row)
```

### Code generation

As we have mentioned above, `pg_slowjit` emits C codes and compile C codes to shared libraries to jit expressions. I learned it from Andy Pavlo's database lecture[^6]. It's easy to implement and quite interesting. I didn't even realize that a C compiler could be a JIT compiler before watching the lecture. In this section, we will emit a function with name `slowjit_eval_expr_<MyProcPid>_<module_generation>`, where `MyProcPid` is the process id of the current server process and `module_generation` is the number of emitted functions. We add these two variables to the emitted function to avoid symbol collision since there might be multiple functions being emitted for a single query. By now, We have nothing to emit but some comments like: "`// OP(<opcode>) to implement`".

<details>
  <summary> pg_slowjit/slowjit.c  (Click me to view the diff)</summary>

```diff
 /* A bunch of header files. */
 #include "postgres.h"
 
 #include "c.h"
 #include "executor/execExpr.h"
 #include "fmgr.h"
 #include "jit/jit.h"
 #include "lib/stringinfo.h"
 #include "miscadmin.h"
 #include "nodes/execnodes.h"
 #include "nodes/pg_list.h"
 #include "pg_config_manual.h"
 #include "utils/elog.h"
 #include "utils/memutils.h"
 #include "utils/palloc.h"
 #include "utils/resowner.h"
 #include "utils/resowner_private.h"
 
 #include <dlfcn.h>
 #include <stdbool.h>
 #include <stdint.h>
 #include <stdio.h>
 #include <stdlib.h>
 
 PG_MODULE_MAGIC;
 
+/*
+ * To avoid symbol name collision, we use this variable to count the number of
+ * emitted functions and use it as a part of the emitted function's name.
+ */
+static int module_generation = 0;
+
 extern void _PG_jit_provider_init(JitProviderCallbacks *cb);
 
 typedef struct SlowJitContext {
   JitContext base;
   /* Fields to be implemented later. */
 } SlowJitContext;
 
 /* Function prototypes for JIT compilation. */
 static bool slowjit_compile_expr(ExprState *state) {
   PlanState *parent = state->parent;
   SlowJitContext *jit_ctx = NULL;
+  /* The name of the emitted function. */
+  char symbol_name[MAXPGPATH];
+  /* Buffer to hold emitted C codes. */
+  StringInfoData code_holder;
 
   /* parent shouldn't be NULL. */
   Assert(parent != NULL);
 
   /*
    * Emit a notice message so that we can check if the JIT provider being
    * loaded successfully.
    */
   elog(NOTICE, "slowjit_compile_expr");
 
   /* Initialize the context. */
   if (parent->state->es_jit) {
     /*
      * We can reuse the JIT context.
      */
     jit_ctx = (SlowJitContext *)parent->state->es_jit;
   } else {
     ResourceOwnerEnlargeJIT(CurrentResourceOwner);
 
     jit_ctx = (SlowJitContext *)MemoryContextAllocZero(TopMemoryContext,
                                                        sizeof(SlowJitContext));
     jit_ctx->base.flags = parent->state->es_jit_flags;
 
     /* ensure cleanup */
     jit_ctx->base.resowner = CurrentResourceOwner;
     ResourceOwnerRememberJIT(CurrentResourceOwner, PointerGetDatum(jit_ctx));
 
     /* For re-using the JIT context. */
     parent->state->es_jit = &jit_ctx->base;
   }
 
+  initStringInfo(&code_holder);
+
+#define emit_line(...)                                                         \
+  do {                                                                         \
+    appendStringInfo(&code_holder, __VA_ARGS__);                               \
+    appendStringInfoChar(&code_holder, '\n');                                  \
+  } while (0)
+
+#define emit_include(header) emit_line("#include \"%s\"", header)
+
+  emit_include("postgres.h");
+  emit_include("nodes/execnodes.h");
+
+  /*
+   * Emit the jitted function signature.
+   * We use MyProcPid and module_generation to avoid symbol name collision.
+   */
+  snprintf(symbol_name, MAXPGPATH, "slowjit_eval_expr_%d_%d", MyProcPid,
+           module_generation);
+  emit_line("Datum %s(ExprState *state, ExprContext *econtext, bool *isnull)",
+            symbol_name);
+
+  /* Open function body. */
+  emit_line("{");
+
+  for (int opno = 0; opno < state->steps_len; ++opno) {
+    ExprEvalStep *op;
+    ExprEvalOp opcode;
+
+    op = &state->steps[opno];
+    opcode = ExecEvalStepOp(state, op);
+
+    switch (opcode) {
+    default: {
+      emit_line("// OP(%d) to implement", opcode);
+    }
+    }
+  }
+
+  /* Close function body. */
+  emit_line("}");
+
+  /* Print the emitted function to the psql console. */
+  elog(NOTICE, "\n%s", code_holder.data);
+
   /* Returning 'false' indicates we won't jit the current expression. */
   return false;
 }
 static void slowjit_release_context(JitContext *ctx) {
   elog(NOTICE, "slowjit_release_context");
 }
 static void slowjit_reset_after_error(void) {
   elog(NOTICE, "slowjit_reset_after_error");
 }
 
 /* Function where we initialize JIT compilation callbacks. */
 void _PG_jit_provider_init(JitProviderCallbacks *cb) {
   cb->compile_expr = slowjit_compile_expr;
   cb->release_context = slowjit_release_context;
   cb->reset_after_error = slowjit_reset_after_error;
 }
```

</details>

Re-compile the module and re-run the query `SELECT 1`.

```sql
postgres=# EXPLAIN SELECT 1;
NOTICE:  slowjit_compile_expr
NOTICE:
#include "postgres.h"
#include "nodes/execnodes.h"
Datum slowjit_eval_expr_89791_0(ExprState *state, ExprContext *econtext, bool *isnull)
{
// OP(16) to implement
// OP(14) to implement
// OP(0) to implement
}

NOTICE:  slowjit_release_context
                QUERY PLAN
------------------------------------------
 Result  (cost=0.00..0.01 rows=1 width=4)
(1 row)
```

In order to jit the simplest query `SELECT 1`, we need to implement 3 operators: `EEOP_CONST (16)`, `EEOP_ASSIGN_TMP (14)`, `EEOP_DONE (0)`. Remember what we have mentioned in [the begining of this chapter](#implement-our-own-jit-provider-prototype)?

> The emitted function is identical to [`src/backend/executor/execExprInterp.c:ExecInterpExpr`](https://github.com/postgres/postgres/blob/526fe0d79914b2dfcfd79effd1ab26ff62469248/src/backend/executor/execExprInterp.c#L395).

The implementation of these 3 operators looks like:

```c
  EEO_CASE(EEOP_DONE)
  {
    goto out;
  }
  ...
  EEO_CASE(EEOP_ASSIGN_TMP)
  {
    int resultnum = op->d.assign_tmp.resultnum;
    Assert(resultnum >= 0 && resultnum < resultslot->tts_tupleDescriptor->natts);
    resultslot->tts_values[resultnum] = state->resvalue;
    resultslot->tts_isnull[resultnum] = state->resnull;
    EEO_NEXT();
  }
  ...
  EEO_CASE(EEOP_CONST)
  {
    *op->resnull = op->d.constval.isnull;
    *op->resvalue = op->d.constval.value;
    EEO_NEXT();
  }
  ...
out:
  *isnull = state->resnull;
  return state->resvalue;
```

We can copy\&paste the logic to `slowjit_compile_expr`.

<details>
  <summary> pg_slowjit/slowjit.c  (Click me to view the diff)</summary>

```diff
 /* A bunch of header files. */
 #include "postgres.h"
 
 #include "c.h"
 #include "executor/execExpr.h"
 #include "fmgr.h"
 #include "jit/jit.h"
 #include "lib/stringinfo.h"
 #include "miscadmin.h"
 #include "nodes/execnodes.h"
 #include "nodes/pg_list.h"
 #include "pg_config_manual.h"
 #include "utils/elog.h"
 #include "utils/memutils.h"
 #include "utils/palloc.h"
 #include "utils/resowner.h"
 #include "utils/resowner_private.h"
 
 #include <dlfcn.h>
 #include <stdbool.h>
 #include <stdint.h>
 #include <stdio.h>
 #include <stdlib.h>
 
 PG_MODULE_MAGIC;
 
 /*
  * To avoid symbol name collision, we use this variable to count the number of
  * emitted functions and use it as a part of the emitted function's name.
  */
 static int module_generation = 0;
 
 extern void _PG_jit_provider_init(JitProviderCallbacks *cb);
 
 typedef struct SlowJitContext {
   JitContext base;
   /* Fields to be implemented later. */
 } SlowJitContext;
 
 /* Function prototypes for JIT compilation. */
 static bool slowjit_compile_expr(ExprState *state) {
   PlanState *parent = state->parent;
   SlowJitContext *jit_ctx = NULL;
   /* The name of the emitted function. */
   char symbol_name[MAXPGPATH];
   /* Buffer to hold emitted C codes. */
   StringInfoData code_holder;
 
   /* parent shouldn't be NULL. */
   Assert(parent != NULL);
 
   /*
    * Emit a notice message so that we can check if the JIT provider being
    * loaded successfully.
    */
   elog(NOTICE, "slowjit_compile_expr");
 
   /* Initialize the context. */
   if (parent->state->es_jit) {
     /*
      * We can reuse the JIT context.
      */
     jit_ctx = (SlowJitContext *)parent->state->es_jit;
   } else {
     ResourceOwnerEnlargeJIT(CurrentResourceOwner);
 
     jit_ctx = (SlowJitContext *)MemoryContextAllocZero(TopMemoryContext,
                                                        sizeof(SlowJitContext));
     jit_ctx->base.flags = parent->state->es_jit_flags;
 
     /* ensure cleanup */
     jit_ctx->base.resowner = CurrentResourceOwner;
     ResourceOwnerRememberJIT(CurrentResourceOwner, PointerGetDatum(jit_ctx));
 
     /* For re-using the JIT context. */
     parent->state->es_jit = &jit_ctx->base;
   }
 
   initStringInfo(&code_holder);
 
 #define emit_line(...)                                                         \
   do {                                                                         \
     appendStringInfo(&code_holder, __VA_ARGS__);                               \
     appendStringInfoChar(&code_holder, '\n');                                  \
   } while (0)
 
 #define emit_include(header) emit_line("#include \"%s\"", header)
 
   emit_include("postgres.h");
   emit_include("nodes/execnodes.h");
 
   /*
    * Emit the jitted function signature.
    * We use MyProcPid and module_generation to avoid symbol name collision.
    */
   snprintf(symbol_name, MAXPGPATH, "slowjit_eval_expr_%d_%d", MyProcPid,
            module_generation);
   emit_line("Datum %s(ExprState *state, ExprContext *econtext, bool *isnull)",
             symbol_name);
 
   /* Open function body. */
   emit_line("{");
 
   for (int opno = 0; opno < state->steps_len; ++opno) {
     ExprEvalStep *op;
     ExprEvalOp opcode;
 
     op = &state->steps[opno];
     opcode = ExecEvalStepOp(state, op);
 
     switch (opcode) {
+    case EEOP_DONE: {
+      emit_line("  { // EEOP_DONE");
+      emit_line("    *isnull = state->resnull;");
+      emit_line("  }");
+      emit_line("  return state->resvalue;");
+
+      /* Close function boday. */
+      emit_line("}");
+      break;
+    }
+    case EEOP_ASSIGN_TMP: {
+      int resultnum = op->d.assign_tmp.resultnum;
+      emit_line("  { // EEOP_ASSIGN_TMP");
+      emit_line("    TupleTableSlot *resultslot = state->resultslot;");
+      emit_line("    resultslot->tts_values[%d] = state->resvalue;", resultnum);
+      emit_line("    resultslot->tts_isnull[%d] = state->resnull;", resultnum);
+      emit_line("  }");
+      break;
+    }
+    case EEOP_CONST: {
+      emit_line("  { // EEOP_CONST");
+      emit_line("    bool *resnull = (bool *) %lu;", (uint64_t)op->resnull);
+      emit_line("    Datum *resvalue = (Datum *) %lu;", (uint64_t)op->resvalue);
+      emit_line("    *resnull = (bool) %d;", op->d.constval.isnull);
+      emit_line("    *resvalue = (Datum) %luull;", op->d.constval.value);
+      emit_line("  }");
+      break;
+    }
     default: {
       emit_line("// OP(%d) to implement", opcode);
     }
     }
   }
 
-  /* Close function body. */
-  emit_line("}");
-
   /* Print the emitted function to the psql console. */
   elog(NOTICE, "\n%s", code_holder.data);
 
   /* Returning 'false' indicates we won't jit the current expression. */
   return false;
 }
 static void slowjit_release_context(JitContext *ctx) {
   elog(NOTICE, "slowjit_release_context");
 }
 static void slowjit_reset_after_error(void) {
   elog(NOTICE, "slowjit_reset_after_error");
 }
 
 /* Function where we initialize JIT compilation callbacks. */
 void _PG_jit_provider_init(JitProviderCallbacks *cb) {
   cb->compile_expr = slowjit_compile_expr;
   cb->release_context = slowjit_release_context;
   cb->reset_after_error = slowjit_reset_after_error;
 }
```

</details>

Again, re-compile the module and re-run the `SELECT 1` query.

```sql
postgres=# EXPLAIN SELECT 1;
NOTICE:  slowjit_compile_expr
NOTICE:
#include "postgres.h"
#include "nodes/execnodes.h"
Datum slowjit_eval_expr_113916_0(ExprState *state, ExprContext *econtext, bool *isnull)
{
  { // EEOP_CONST
    bool *resnull = (bool *) 94251888729381;
    Datum *resvalue = (Datum *) 94251888729384;
    *resnull = (bool) 0;
    *resvalue = (Datum) 1ull;
  }
  { // EEOP_ASSIGN_TMP
    TupleTableSlot *resultslot = state->resultslot;
    resultslot->tts_values[0] = state->resvalue;
    resultslot->tts_isnull[0] = state->resnull;
  }
  { // EEOP_DONE
    *isnull = state->resnull;
  }
  return state->resvalue;
}

NOTICE:  slowjit_release_context
                QUERY PLAN
------------------------------------------
 Result  (cost=0.00..0.01 rows=1 width=4)
(1 row)
```

### Compile and load the emitted function

To complete our JIT provider, we need to replace the function for executing low level opcodes to our emitted function. The basic idea is compiling the emitted function to a shared library and load the function from the library via `dlopen()` and `dlsym()`.

<details>
  <summary> pg_slowjit/slowjit.c  (Click me to view the diff)</summary>

```diff
 /* A bunch of header files. */
 #include "postgres.h"
 
 #include "c.h"
 #include "executor/execExpr.h"
 #include "fmgr.h"
 #include "jit/jit.h"
 #include "lib/stringinfo.h"
 #include "miscadmin.h"
 #include "nodes/execnodes.h"
 #include "nodes/pg_list.h"
 #include "pg_config_manual.h"
 #include "utils/elog.h"
 #include "utils/memutils.h"
 #include "utils/palloc.h"
 #include "utils/resowner.h"
 #include "utils/resowner_private.h"
 
 #include <dlfcn.h>
 #include <stdbool.h>
 #include <stdint.h>
 #include <stdio.h>
 #include <stdlib.h>
 
 PG_MODULE_MAGIC;
 
 /*
  * To avoid symbol name collision, we use this variable to count the number of
  * emitted functions and use it as a part of the emitted function's name.
  */
 static int module_generation = 0;
 
 extern void _PG_jit_provider_init(JitProviderCallbacks *cb);
 
 typedef struct SlowJitContext {
   JitContext base;
   /* Fields to be implemented later. */
 } SlowJitContext;
 
 /* Function prototypes for JIT compilation. */
 static bool slowjit_compile_expr(ExprState *state) {
   PlanState *parent = state->parent;
   SlowJitContext *jit_ctx = NULL;
   /* The name of the emitted function. */
   char symbol_name[MAXPGPATH];
   /* Buffer to hold emitted C codes. */
   StringInfoData code_holder;
 
   /* parent shouldn't be NULL. */
   Assert(parent != NULL);
 
   /*
    * Emit a notice message so that we can check if the JIT provider being
    * loaded successfully.
    */
   elog(NOTICE, "slowjit_compile_expr");
 
   /* Initialize the context. */
   if (parent->state->es_jit) {
     /*
      * We can reuse the JIT context.
      */
     jit_ctx = (SlowJitContext *)parent->state->es_jit;
   } else {
     ResourceOwnerEnlargeJIT(CurrentResourceOwner);
 
     jit_ctx = (SlowJitContext *)MemoryContextAllocZero(TopMemoryContext,
                                                        sizeof(SlowJitContext));
     jit_ctx->base.flags = parent->state->es_jit_flags;
 
     /* ensure cleanup */
     jit_ctx->base.resowner = CurrentResourceOwner;
     ResourceOwnerRememberJIT(CurrentResourceOwner, PointerGetDatum(jit_ctx));
 
     /* For re-using the JIT context. */
     parent->state->es_jit = &jit_ctx->base;
   }
 
   initStringInfo(&code_holder);
 
 #define emit_line(...)                                                         \
   do {                                                                         \
     appendStringInfo(&code_holder, __VA_ARGS__);                               \
     appendStringInfoChar(&code_holder, '\n');                                  \
   } while (0)
 
 #define emit_include(header) emit_line("#include \"%s\"", header)
 
   emit_include("postgres.h");
   emit_include("nodes/execnodes.h");
 
   /*
    * Emit the jitted function signature.
    * We use MyProcPid and module_generation to avoid symbol name collision.
    */
   snprintf(symbol_name, MAXPGPATH, "slowjit_eval_expr_%d_%d", MyProcPid,
            module_generation);
   emit_line("Datum %s(ExprState *state, ExprContext *econtext, bool *isnull)",
             symbol_name);
 
   /* Open function body. */
   emit_line("{");
 
   for (int opno = 0; opno < state->steps_len; ++opno) {
     ExprEvalStep *op;
     ExprEvalOp opcode;
 
     op = &state->steps[opno];
     opcode = ExecEvalStepOp(state, op);
 
     switch (opcode) {
     case EEOP_DONE: {
       emit_line("  { // EEOP_DONE");
       emit_line("    *isnull = state->resnull;");
       emit_line("  }");
       emit_line("  return state->resvalue;");
 
       /* Close function boday. */
       emit_line("}");
       break;
     }
     case EEOP_ASSIGN_TMP: {
       int resultnum = op->d.assign_tmp.resultnum;
       emit_line("  { // EEOP_ASSIGN_TMP");
       emit_line("    TupleTableSlot *resultslot = state->resultslot;");
       emit_line("    resultslot->tts_values[%d] = state->resvalue;", resultnum);
       emit_line("    resultslot->tts_isnull[%d] = state->resnull;", resultnum);
       emit_line("  }");
       break;
     }
     case EEOP_CONST: {
       emit_line("  { // EEOP_CONST");
       emit_line("    bool *resnull = (bool *) %lu;", (uint64_t)op->resnull);
       emit_line("    Datum *resvalue = (Datum *) %lu;", (uint64_t)op->resvalue);
       emit_line("    *resnull = (bool) %d;", op->d.constval.isnull);
       emit_line("    *resvalue = (Datum) %luull;", op->d.constval.value);
       emit_line("  }");
       break;
     }
     default: {
       emit_line("// OP(%d) to implement", opcode);
     }
     }
   }
 
-  /* Print the emitted function to the psql console. */
-  elog(NOTICE, "\n%s", code_holder.data);
+  {
+    char c_src_path[MAXPGPATH];
+    char shared_library_path[MAXPGPATH];
+    char include_server_path[MAXPGPATH];
+    char compile_command[MAXPGPATH];
+    FILE *c_src_file;
+    void *handle;
+    void *jitted_func;
+
+    /* Write the emitted C codes to a file. */
+    snprintf(c_src_path, MAXPGPATH, "/tmp/%d.%d.c", MyProcPid,
+             module_generation);
+    c_src_file = fopen(c_src_path, "w+");
+    if (c_src_file == NULL) {
+      ereport(ERROR, (errmsg("cannot open file '%s' for write", c_src_path)));
+    }
+    fwrite(code_holder.data, 1, code_holder.len, c_src_file);
+    fclose(c_src_file);
+    resetStringInfo(&code_holder);
+    pfree(code_holder.data);
+
+    /* Prepare the compile command. */
+    snprintf(shared_library_path, MAXPGPATH, "/tmp/%d.%d.so", MyProcPid,
+             module_generation);
+    get_includeserver_path(my_exec_path, include_server_path);
+    snprintf(compile_command, MAXPGPATH, "cc -fPIC -I%s -shared -O3 -o %s %s",
+             include_server_path, shared_library_path, c_src_path);
+
+    /* Compile the codes */
+    if (system(compile_command) != 0) {
+      ereport(ERROR, (errmsg("cannot execute command: %s", compile_command)));
+    }
+
+    /* Load the shared library to the current process. */
+    handle = dlopen(shared_library_path, RTLD_LAZY);
+    if (handle == NULL) {
+      char *err = dlerror();
+      ereport(ERROR,
+              (errmsg("cannot dlopen '%s': %s", shared_library_path, err)));
+    }
+
+    /* Find the function pointer and save it to state->evalfunc */
+    jitted_func = dlsym(handle, symbol_name);
+    if (jitted_func == NULL) {
+      char *err = dlerror();
+      ereport(ERROR, (errmsg("cannot find symbol '%s' from '%s': %s",
+                             symbol_name, shared_library_path, err)));
+    }
+
+    state->evalfunc = jitted_func;
+    state->evalfunc_private = NULL;
+    module_generation++;
+  }
 
-  /* Returning 'false' indicates we won't jit the current expression. */
-  return false;
+  return true;
 }
 static void slowjit_release_context(JitContext *ctx) {
   elog(NOTICE, "slowjit_release_context");
 }
 static void slowjit_reset_after_error(void) {
   elog(NOTICE, "slowjit_reset_after_error");
 }
 
 /* Function where we initialize JIT compilation callbacks. */
 void _PG_jit_provider_init(JitProviderCallbacks *cb) {
   cb->compile_expr = slowjit_compile_expr;
   cb->release_context = slowjit_release_context;
   cb->reset_after_error = slowjit_reset_after_error;
 }
```

</details>

Now, we can jit the simplest query!! But there're still some problems. After loading the shared library, we lose track of the handle. We need to close the handle of the shared library after the query finishing.

<details>
  <summary> pg_slowjit/slowjit.c  (Click me to view the diff)</summary>

```diff
 /* A bunch of header files. */
 #include "postgres.h"
 
 #include "c.h"
 #include "executor/execExpr.h"
 #include "fmgr.h"
 #include "jit/jit.h"
 #include "lib/stringinfo.h"
 #include "miscadmin.h"
 #include "nodes/execnodes.h"
 #include "nodes/pg_list.h"
 #include "pg_config_manual.h"
 #include "utils/elog.h"
 #include "utils/memutils.h"
 #include "utils/palloc.h"
 #include "utils/resowner.h"
 #include "utils/resowner_private.h"
 
 #include <dlfcn.h>
 #include <stdbool.h>
 #include <stdint.h>
 #include <stdio.h>
 #include <stdlib.h>
 
 PG_MODULE_MAGIC;
 
 /*
  * To avoid symbol name collision, we use this variable to count the number of
  * emitted functions and use it as a part of the emitted function's name.
  */
 static int module_generation = 0;
 
 extern void _PG_jit_provider_init(JitProviderCallbacks *cb);
 
 typedef struct SlowJitContext {
   JitContext base;
-  /* Fields to be implemented later. */
+  List *handles;
 } SlowJitContext;
 
 /* Function prototypes for JIT compilation. */
 static bool slowjit_compile_expr(ExprState *state) {
   PlanState *parent = state->parent;
   SlowJitContext *jit_ctx = NULL;
   /* The name of the emitted function. */
   char symbol_name[MAXPGPATH];
   /* Buffer to hold emitted C codes. */
   StringInfoData code_holder;
 
   /* parent shouldn't be NULL. */
   Assert(parent != NULL);
 
   /*
    * Emit a notice message so that we can check if the JIT provider being
    * loaded successfully.
    */
   elog(NOTICE, "slowjit_compile_expr");
 
   /* Initialize the context. */
   if (parent->state->es_jit) {
     /*
      * We can reuse the JIT context.
      */
     jit_ctx = (SlowJitContext *)parent->state->es_jit;
   } else {
     ResourceOwnerEnlargeJIT(CurrentResourceOwner);
 
     jit_ctx = (SlowJitContext *)MemoryContextAllocZero(TopMemoryContext,
                                                        sizeof(SlowJitContext));
     jit_ctx->base.flags = parent->state->es_jit_flags;
 
     /* ensure cleanup */
     jit_ctx->base.resowner = CurrentResourceOwner;
     ResourceOwnerRememberJIT(CurrentResourceOwner, PointerGetDatum(jit_ctx));
 
     /* For re-using the JIT context. */
     parent->state->es_jit = &jit_ctx->base;
   }
 
   initStringInfo(&code_holder);
 
 #define emit_line(...)                                                         \
   do {                                                                         \
     appendStringInfo(&code_holder, __VA_ARGS__);                               \
     appendStringInfoChar(&code_holder, '\n');                                  \
   } while (0)
 
 #define emit_include(header) emit_line("#include \"%s\"", header)
 
   emit_include("postgres.h");
   emit_include("nodes/execnodes.h");
 
   /*
    * Emit the jitted function signature.
    * We use MyProcPid and module_generation to avoid symbol name collision.
    */
   snprintf(symbol_name, MAXPGPATH, "slowjit_eval_expr_%d_%d", MyProcPid,
            module_generation);
   emit_line("Datum %s(ExprState *state, ExprContext *econtext, bool *isnull)",
             symbol_name);
 
   /* Open function body. */
   emit_line("{");
 
   for (int opno = 0; opno < state->steps_len; ++opno) {
     ExprEvalStep *op;
     ExprEvalOp opcode;
 
     op = &state->steps[opno];
     opcode = ExecEvalStepOp(state, op);
 
     switch (opcode) {
     case EEOP_DONE: {
       emit_line("  { // EEOP_DONE");
       emit_line("    *isnull = state->resnull;");
       emit_line("  }");
       emit_line("  return state->resvalue;");
 
       /* Close function boday. */
       emit_line("}");
       break;
     }
     case EEOP_ASSIGN_TMP: {
       int resultnum = op->d.assign_tmp.resultnum;
       emit_line("  { // EEOP_ASSIGN_TMP");
       emit_line("    TupleTableSlot *resultslot = state->resultslot;");
       emit_line("    resultslot->tts_values[%d] = state->resvalue;", resultnum);
       emit_line("    resultslot->tts_isnull[%d] = state->resnull;", resultnum);
       emit_line("  }");
       break;
     }
     case EEOP_CONST: {
       emit_line("  { // EEOP_CONST");
       emit_line("    bool *resnull = (bool *) %lu;", (uint64_t)op->resnull);
       emit_line("    Datum *resvalue = (Datum *) %lu;", (uint64_t)op->resvalue);
       emit_line("    *resnull = (bool) %d;", op->d.constval.isnull);
       emit_line("    *resvalue = (Datum) %luull;", op->d.constval.value);
       emit_line("  }");
       break;
     }
     default: {
       emit_line("// OP(%d) to implement", opcode);
     }
     }
   }
 
   {
     char c_src_path[MAXPGPATH];
     char shared_library_path[MAXPGPATH];
     char include_server_path[MAXPGPATH];
     char compile_command[MAXPGPATH];
     FILE *c_src_file;
     void *handle;
     void *jitted_func;
+    MemoryContext oldctx;
 
     /* Write the emitted C codes to a file. */
     snprintf(c_src_path, MAXPGPATH, "/tmp/%d.%d.c", MyProcPid,
              module_generation);
     c_src_file = fopen(c_src_path, "w+");
     if (c_src_file == NULL) {
       ereport(ERROR, (errmsg("cannot open file '%s' for write", c_src_path)));
     }
     fwrite(code_holder.data, 1, code_holder.len, c_src_file);
     fclose(c_src_file);
     resetStringInfo(&code_holder);
     pfree(code_holder.data);
 
     /* Prepare the compile command. */
     snprintf(shared_library_path, MAXPGPATH, "/tmp/%d.%d.so", MyProcPid,
              module_generation);
     get_includeserver_path(my_exec_path, include_server_path);
     snprintf(compile_command, MAXPGPATH, "cc -fPIC -I%s -shared -O3 -o %s %s",
              include_server_path, shared_library_path, c_src_path);
 
     /* Compile the codes */
     if (system(compile_command) != 0) {
       ereport(ERROR, (errmsg("cannot execute command: %s", compile_command)));
     }
 
     /* Load the shared library to the current process. */
     handle = dlopen(shared_library_path, RTLD_LAZY);
     if (handle == NULL) {
       char *err = dlerror();
       ereport(ERROR,
               (errmsg("cannot dlopen '%s': %s", shared_library_path, err)));
     }
 
+    /*
+     * Keep track of the handle of the shared library, so that we can release it
+     * later.
+     */
+    oldctx = MemoryContextSwitchTo(TopMemoryContext);
+    jit_ctx->handles = lappend(jit_ctx->handles, handle);
+    MemoryContextSwitchTo(oldctx);
+
     /* Find the function pointer and save it to state->evalfunc */
     jitted_func = dlsym(handle, symbol_name);
     if (jitted_func == NULL) {
       char *err = dlerror();
       ereport(ERROR, (errmsg("cannot find symbol '%s' from '%s': %s",
                              symbol_name, shared_library_path, err)));
     }
 
     state->evalfunc = jitted_func;
     state->evalfunc_private = NULL;
     module_generation++;
   }
 
   return true;
 }
 static void slowjit_release_context(JitContext *ctx) {
-  elog(NOTICE, "slowjit_release_context");
+  SlowJitContext *jit_ctx = (SlowJitContext *)ctx;
+  ListCell *lc;
+
+  foreach (lc, jit_ctx->handles) {
+    void *handle = (void *)lfirst(lc);
+    dlclose(handle);
+  }
+  list_free(jit_ctx->handles);
+  jit_ctx->handles = NIL;
 }
 static void slowjit_reset_after_error(void) {
   elog(NOTICE, "slowjit_reset_after_error");
 }
 
 /* Function where we initialize JIT compilation callbacks. */
 void _PG_jit_provider_init(JitProviderCallbacks *cb) {
   cb->compile_expr = slowjit_compile_expr;
   cb->release_context = slowjit_release_context;
   cb->reset_after_error = slowjit_reset_after_error;
 }
```

</details>

### Instrumentation statistics

Something is still missing from our JIT provider. That is instrumentation statistics. The LLVM JIT provider is able to report some statistics about the JIT compilation, e.g., the number of jitted functions, code generation time, etc.

```sql
postgres=# EXPLAIN (ANALYZE) SELECT 1;
                                                          QUERY PLAN
-------------------------------------------------------------------------------------------------------------------------------
 Result  (cost=0.00..0.01 rows=1 width=4) (actual time=11.966..11.967 rows=1 loops=1)
 Planning Time: 0.031 ms
 JIT:
   Functions: 1
   Options: Inlining false, Optimization false, Expressions true, Deforming true
   Timing: Generation 0.075 ms (Deform 0.000 ms), Inlining 0.000 ms, Optimization 7.857 ms, Emission 4.099 ms, Total 12.031 ms
 Execution Time: 12.113 ms
(7 rows)
```

There're various kinds of information about JIT compilation being recorded in the `JitContext::instr` field.

```c
typedef struct JitInstrumentation
{
  /* number of emitted functions */
  size_t created_functions;
  /* accumulated time to generate code */
  instr_time generation_counter;
  /* accumulated time to deform tuples, included into generation_counter */
  instr_time deform_counter;
  /* accumulated time for inlining */
  instr_time inlining_counter;
  /* accumulated time for optimization */
  instr_time optimization_counter;
  /* accumulated time for code emission */
  instr_time emission_counter;
} JitInstrumentation;
```

Let's implement some of them to complete our prototype. The following diff adds support for counting created functions and the total generation time.

<details>
  <summary> pg_slowjit/slowjit.c  (Click me to view the diff)</summary>

```diff
 /* A bunch of header files. */
 #include "postgres.h"
 
 #include "c.h"
 #include "executor/execExpr.h"
 #include "fmgr.h"
 #include "jit/jit.h"
 #include "lib/stringinfo.h"
 #include "miscadmin.h"
 #include "nodes/execnodes.h"
 #include "nodes/pg_list.h"
 #include "pg_config_manual.h"
+#include "portability/instr_time.h"
 #include "utils/elog.h"
 #include "utils/memutils.h"
 #include "utils/palloc.h"
 #include "utils/resowner.h"
 #include "utils/resowner_private.h"
 
 #include <dlfcn.h>
 #include <stdbool.h>
 #include <stdint.h>
 #include <stdio.h>
 #include <stdlib.h>
 
 PG_MODULE_MAGIC;
 
 /*
  * To avoid symbol name collision, we use this variable to count the number of
  * emitted functions and use it as a part of the emitted function's name.
  */
 static int module_generation = 0;
 
 extern void _PG_jit_provider_init(JitProviderCallbacks *cb);
 
 typedef struct SlowJitContext {
   JitContext base;
   List *handles;
 } SlowJitContext;
 
 /* Function prototypes for JIT compilation. */
 static bool slowjit_compile_expr(ExprState *state) {
   PlanState *parent = state->parent;
   SlowJitContext *jit_ctx = NULL;
   /* The name of the emitted function. */
   char symbol_name[MAXPGPATH];
   /* Buffer to hold emitted C codes. */
   StringInfoData code_holder;
+  /* Some instrumentation statistics. */
+  instr_time starttime;
+  instr_time endtime;
 
   /* parent shouldn't be NULL. */
   Assert(parent != NULL);
 
   /*
    * Emit a notice message so that we can check if the JIT provider being
    * loaded successfully.
    */
   elog(NOTICE, "slowjit_compile_expr");
 
   /* Initialize the context. */
   if (parent->state->es_jit) {
     /*
      * We can reuse the JIT context.
      */
     jit_ctx = (SlowJitContext *)parent->state->es_jit;
   } else {
     ResourceOwnerEnlargeJIT(CurrentResourceOwner);
 
     jit_ctx = (SlowJitContext *)MemoryContextAllocZero(TopMemoryContext,
                                                        sizeof(SlowJitContext));
     jit_ctx->base.flags = parent->state->es_jit_flags;
 
     /* ensure cleanup */
     jit_ctx->base.resowner = CurrentResourceOwner;
     ResourceOwnerRememberJIT(CurrentResourceOwner, PointerGetDatum(jit_ctx));
 
     /* For re-using the JIT context. */
     parent->state->es_jit = &jit_ctx->base;
   }
 
+  INSTR_TIME_SET_CURRENT(starttime);
+
   initStringInfo(&code_holder);
 
 #define emit_line(...)                                                         \
   do {                                                                         \
     appendStringInfo(&code_holder, __VA_ARGS__);                               \
     appendStringInfoChar(&code_holder, '\n');                                  \
   } while (0)
 
 #define emit_include(header) emit_line("#include \"%s\"", header)
 
   emit_include("postgres.h");
   emit_include("nodes/execnodes.h");
 
   /*
    * Emit the jitted function signature.
    * We use MyProcPid and module_generation to avoid symbol name collision.
    */
   snprintf(symbol_name, MAXPGPATH, "slowjit_eval_expr_%d_%d", MyProcPid,
            module_generation);
   emit_line("Datum %s(ExprState *state, ExprContext *econtext, bool *isnull)",
             symbol_name);
 
   /* Open function body. */
   emit_line("{");
 
   for (int opno = 0; opno < state->steps_len; ++opno) {
     ExprEvalStep *op;
     ExprEvalOp opcode;
 
     op = &state->steps[opno];
     opcode = ExecEvalStepOp(state, op);
 
     switch (opcode) {
     case EEOP_DONE: {
       emit_line("  { // EEOP_DONE");
       emit_line("    *isnull = state->resnull;");
       emit_line("  }");
       emit_line("  return state->resvalue;");
 
       /* Close function boday. */
       emit_line("}");
       break;
     }
     case EEOP_ASSIGN_TMP: {
       int resultnum = op->d.assign_tmp.resultnum;
       emit_line("  { // EEOP_ASSIGN_TMP");
       emit_line("    TupleTableSlot *resultslot = state->resultslot;");
       emit_line("    resultslot->tts_values[%d] = state->resvalue;", resultnum);
       emit_line("    resultslot->tts_isnull[%d] = state->resnull;", resultnum);
       emit_line("  }");
       break;
     }
     case EEOP_CONST: {
       emit_line("  { // EEOP_CONST");
       emit_line("    bool *resnull = (bool *) %lu;", (uint64_t)op->resnull);
       emit_line("    Datum *resvalue = (Datum *) %lu;", (uint64_t)op->resvalue);
       emit_line("    *resnull = (bool) %d;", op->d.constval.isnull);
       emit_line("    *resvalue = (Datum) %luull;", op->d.constval.value);
       emit_line("  }");
       break;
     }
     default: {
       emit_line("// OP(%d) to implement", opcode);
     }
     }
   }
 
   {
     char c_src_path[MAXPGPATH];
     char shared_library_path[MAXPGPATH];
     char include_server_path[MAXPGPATH];
     char compile_command[MAXPGPATH];
     FILE *c_src_file;
     void *handle;
     void *jitted_func;
     MemoryContext oldctx;
 
     /* Write the emitted C codes to a file. */
     snprintf(c_src_path, MAXPGPATH, "/tmp/%d.%d.c", MyProcPid,
              module_generation);
     c_src_file = fopen(c_src_path, "w+");
     if (c_src_file == NULL) {
       ereport(ERROR, (errmsg("cannot open file '%s' for write", c_src_path)));
     }
     fwrite(code_holder.data, 1, code_holder.len, c_src_file);
     fclose(c_src_file);
     resetStringInfo(&code_holder);
     pfree(code_holder.data);
 
     /* Prepare the compile command. */
     snprintf(shared_library_path, MAXPGPATH, "/tmp/%d.%d.so", MyProcPid,
              module_generation);
     get_includeserver_path(my_exec_path, include_server_path);
     snprintf(compile_command, MAXPGPATH, "cc -fPIC -I%s -shared -O3 -o %s %s",
              include_server_path, shared_library_path, c_src_path);
 
     /* Compile the codes */
     if (system(compile_command) != 0) {
       ereport(ERROR, (errmsg("cannot execute command: %s", compile_command)));
     }
 
     /* Load the shared library to the current process. */
     handle = dlopen(shared_library_path, RTLD_LAZY);
     if (handle == NULL) {
       char *err = dlerror();
       ereport(ERROR,
               (errmsg("cannot dlopen '%s': %s", shared_library_path, err)));
     }
 
     /*
      * Keep track of the handle of the shared library, so that we can release it
      * later.
      */
     oldctx = MemoryContextSwitchTo(TopMemoryContext);
     jit_ctx->handles = lappend(jit_ctx->handles, handle);
     MemoryContextSwitchTo(oldctx);
 
     /* Find the function pointer and save it to state->evalfunc */
     jitted_func = dlsym(handle, symbol_name);
     if (jitted_func == NULL) {
       char *err = dlerror();
       ereport(ERROR, (errmsg("cannot find symbol '%s' from '%s': %s",
                              symbol_name, shared_library_path, err)));
     }
 
     state->evalfunc = jitted_func;
     state->evalfunc_private = NULL;
     module_generation++;
+    jit_ctx->base.instr.created_functions++;
   }
 
+  INSTR_TIME_SET_CURRENT(endtime);
+  INSTR_TIME_ACCUM_DIFF(jit_ctx->base.instr.generation_counter, endtime,
+                        starttime);
+
   return true;
 }
 static void slowjit_release_context(JitContext *ctx) {
   SlowJitContext *jit_ctx = (SlowJitContext *)ctx;
   ListCell *lc;
 
   foreach (lc, jit_ctx->handles) {
     void *handle = (void *)lfirst(lc);
     dlclose(handle);
   }
   list_free(jit_ctx->handles);
   jit_ctx->handles = NIL;
 }
 static void slowjit_reset_after_error(void) {
   elog(NOTICE, "slowjit_reset_after_error");
 }
 
 /* Function where we initialize JIT compilation callbacks. */
 void _PG_jit_provider_init(JitProviderCallbacks *cb) {
   cb->compile_expr = slowjit_compile_expr;
   cb->release_context = slowjit_release_context;
   cb->reset_after_error = slowjit_reset_after_error;
 }
```

</details>

Our prototype is able to report some statistics!

```sql
postgres=# EXPLAIN (ANALYZE) SELECT 1;
NOTICE:  slowjit_compile_expr
                                                           QUERY PLAN
--------------------------------------------------------------------------------------------------------------------------------
 Result  (cost=0.00..0.01 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=1)
 Planning Time: 0.125 ms
 JIT:
   Functions: 1
   Options: Inlining false, Optimization false, Expressions true, Deforming true
   Timing: Generation 71.044 ms (Deform 0.000 ms), Inlining 0.000 ms, Optimization 0.000 ms, Emission 0.000 ms, Total 71.044 ms
 Execution Time: 71.358 ms
(7 rows)
```

## Conclusion

In this blog post, we implemented a simple and low efficient JIT provider prototype. There're several aspects that can be improved.

1. Each shared library only contains one function. Sometimes we need to compile several shared libraries to jit a single query. The LLVM JIT provider of PostgreSQL can emit several functions in one go. It can save some time in compiling the shared library and loading the function.

2. In order to make this article easy to understand, some of the codes are incorrect. E.g., The `default` branch of the switch-clause for code generation should return false to stop jitting unsupported queries, otherwise incorrect result will be produced and server may crash.

3. Test cases for the JIT provider are missing. I usually test it by running the PostgreSQL regression test suite with the JIT provider being loaded.

The full codes for this post can be found in the `blog` branch of [higuoxing/pg_slowjit](https://github.com/higuoxing/pg_slowjit/tree/blog) and an improved version is in the [`main`](https://github.com/higuoxing/pg_slowjit/tree/main) branch.

[^1]: [Pluggable JIT Providers.](https://www.postgresql.org/docs/16/jit-extensibility.html)
[^2]: [pg_slowjit - A simple demo to illustrate how to implement a JIT provider for PostgreSQL.](https://github.com/higuoxing/pg_slowjit)
[^3]: [pg_asmjit - An alternative x86_64 JIT provider (based on asmjit) for PostgreSQL.](https://github.com/higuoxing/pg_asmjit)
[^4]: [AsmJit -- A low-latency machine code generation library written in C++.](https://asmjit.com/)
[^5]: [Extension Building Infrastructure](https://www.postgresql.org/docs/current/extend-pgxs.html)
[^6]: [Query Compilation & JIT Code Generation (CMU Advanced Databases / Spring 2023) ](https://www.youtube.com/watch?v=eurwtUhY5fk)
