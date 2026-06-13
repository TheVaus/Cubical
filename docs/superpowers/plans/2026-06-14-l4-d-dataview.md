# L4-D — Dataview-style libSQL queries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fenced ```` ```query ```` blocks that project typed frontmatter into list / table / count views, evaluated against libSQL and rendered live in the editor.

**Architecture:** A new pure `cubical-query` crate (parser → planner → executor) compiles a small DQL-flavored DSL into parameterized SQL over the existing `files` / `frontmatter` / `tags` tables, normalizing the JSON-encoded `frontmatter.value` through `json_extract(value,'$')`. One vault-id-keyed Tauri command (`dataview_query`) exposes it; a CodeMirror live-preview block widget (mirroring the L3 embed widget) detects the fence and renders the result via a pure, jsdom-tested `dataviewRender.ts`.

**Tech Stack:** Rust (libSQL, thiserror, serde, tokio), Tauri IPC, Solid/TypeScript, CodeMirror 6, vitest (jsdom).

**Design spec:** `docs/superpowers/specs/2026-06-14-l4-d-dataview-design.md`

**Conventions reminder:** `#![forbid(unsafe_code)]` + `#![warn(missing_docs)]` on every crate root (see existing crates). Doc-comment every public item or clippy fails the gate. Commit messages follow `docs/conventions.md`.

---

## File structure

**New crate `crates/cubical-query/`:**
- `Cargo.toml` — deps: `cubical-index` (path), `libsql`, `serde`, `thiserror`; dev-deps: `tokio`, `tempfile`.
- `src/lib.rs` — crate root + public re-exports.
- `src/ast.rs` — `Query` AST types (`Command`, `Source`, `Op`, `Value`, `Cond`, `Sort`, `Query`).
- `src/parser.rs` — `parse(&str) -> Result<Query, ParseError>` (tokenizer + recursive descent).
- `src/plan.rs` — `plan(&Query) -> Plan` (AST → SQL string + typed `SqlParam`s). Pure, no DB.
- `src/exec.rs` — `run(&IndexConn, &Query) -> Result<QueryResult, QueryError>` + result types (`NoteRef`, `Row`, `QueryResult`).
- `src/error.rs` — `ParseError`, `QueryError`.

**Modified `crates/cubical-app/`:**
- `Cargo.toml` — add `cubical-query` path dep.
- `src/api/types.rs` — `DataviewQueryRequest`, `DataviewResult`.
- `src/commands/dataview.rs` — new handler (+ unit tests).
- `src/commands/mod.rs` — `pub mod dataview;`.
- `src/lib.rs` — `#[tauri::command]` shim + register in `generate_handler!`.

**Modified `ui/`:**
- `src/api/ipc.ts` — `dataviewQuery` wrapper + wire types.
- `src/api/dataview.test.ts` — IPC shape smoke (new).
- `src/dataview/dataviewRender.ts` — pure renderer (new).
- `src/dataview/dataviewRender.test.ts` — jsdom tests (new).
- `src/editor/dataview.ts` — CM6 block field + widget + resolver facet (new, operator-smoke).
- `src/editor/livePreview.ts` — add the dataview field to the bundle.

---

## Phase 1 — `cubical-query` crate

### Task 1: Scaffold the crate

**Files:**
- Create: `crates/cubical-query/Cargo.toml`
- Create: `crates/cubical-query/src/lib.rs`

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "cubical-query"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
authors.workspace = true

[dependencies]
cubical-index = { path = "../cubical-index" }
libsql.workspace = true
serde.workspace = true
thiserror.workspace = true

[dev-dependencies]
tokio.workspace = true
tempfile.workspace = true
```

Check `crates/cubical-index/Cargo.toml` first to confirm the exact workspace key names for `libsql`, `serde`, `thiserror`, `tokio`, `tempfile`. If `tempfile` is not yet a workspace dep, use the version already pinned in `cubical-index`'s dev-deps.

- [ ] **Step 2: Write the crate root with a placeholder test**

`crates/cubical-query/src/lib.rs`:

```rust
//! `cubical-query` — the Dataview-style query language for Cubical.
//!
//! Compiles a small DQL-flavored DSL (`LIST` / `TABLE` / `COUNT` with
//! `FROM` / `WHERE` / `SORT`) into parameterized SQL over the
//! `cubical-index` libSQL tables. See
//! `docs/superpowers/specs/2026-06-14-l4-d-dataview-design.md`.
//!
//! Pipeline: [`parse`] (text → [`Query`]) → `plan` (AST → SQL) →
//! `run` (SQL → [`QueryResult`]).

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod ast;
mod error;
mod exec;
mod parser;
mod plan;

pub use ast::{Command, Cond, Op, Query, Sort, SortDir, Source, Value};
pub use error::{ParseError, QueryError};
pub use exec::{run, NoteRef, QueryResult, Row};
pub use parser::parse;
```

This will not compile until the modules exist — Tasks 2-6 create them. Create empty stub files now so the tree compiles incrementally, OR build modules bottom-up (ast → error → parser → plan → exec) and add each `mod`/`pub use` line as you go. Recommended: add the module lines as each module lands.

- [ ] **Step 3: Verify the workspace picks up the crate**

Run: `cargo build -p cubical-query`
Expected: builds (empty crate). If "no targets", ensure `src/lib.rs` exists.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-query/
git commit -m "feat(l4d): scaffold cubical-query crate"
```

---

### Task 2: AST types

**Files:**
- Create: `crates/cubical-query/src/ast.rs`

- [ ] **Step 1: Write the AST module**

`crates/cubical-query/src/ast.rs`:

```rust
//! The query AST — the parser's output, the planner's input.

/// The projection command: what shape the result takes.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// One note link per matching file.
    List,
    /// A column per named frontmatter key (plus an implicit file column).
    Table(Vec<String>),
    /// The number of matching files.
    Count,
}

/// The `FROM` source restricting the candidate file set.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// `#tag` — files carrying this tag or a descendant (prefix match).
    Tag(String),
    /// `"folder/path"` — files whose path is under this folder.
    Folder(String),
}

/// A comparison operator in a `WHERE` condition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// `=`
    Eq,
    /// `!=`
    Ne,
    /// `<`
    Lt,
    /// `<=`
    Le,
    /// `>`
    Gt,
    /// `>=`
    Ge,
}

/// A literal value on the right-hand side of a condition.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// A double-quoted string literal.
    Str(String),
    /// A numeric literal (int or float; stored as f64).
    Num(f64),
    /// A bare `true` / `false`.
    Bool(bool),
}

/// One `WHERE` condition: `key op value`.
#[derive(Debug, Clone, PartialEq)]
pub struct Cond {
    /// The frontmatter key being compared.
    pub key: String,
    /// The comparison operator.
    pub op: Op,
    /// The literal compared against.
    pub value: Value,
}

/// Sort direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDir {
    /// Ascending (default).
    Asc,
    /// Descending.
    Desc,
}

/// The `SORT` clause: a single frontmatter key + direction.
#[derive(Debug, Clone, PartialEq)]
pub struct Sort {
    /// The frontmatter key to sort by.
    pub key: String,
    /// The sort direction.
    pub dir: SortDir,
}

/// A fully parsed query.
#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    /// The projection command.
    pub command: Command,
    /// The `FROM` source, or `None` for "all files".
    pub source: Option<Source>,
    /// `WHERE` conditions, implicitly AND-joined (possibly empty).
    pub conds: Vec<Cond>,
    /// The `SORT` clause, or `None`.
    pub sort: Option<Sort>,
}
```

- [ ] **Step 2: Add `mod ast;` + the `pub use` to `lib.rs`** (if not already present from Task 1).

- [ ] **Step 3: Build**

Run: `cargo build -p cubical-query`
Expected: compiles (types only, no tests yet).

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-query/
git commit -m "feat(l4d): query AST types"
```

---

### Task 3: Error types

**Files:**
- Create: `crates/cubical-query/src/error.rs`

- [ ] **Step 1: Write the error module**

`crates/cubical-query/src/error.rs`:

```rust
//! Error types for parsing and execution.

/// A parse failure with a human-readable message for the ⚠ widget.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ParseError {
    /// What went wrong, phrased for an end user.
    pub message: String,
}

impl ParseError {
    /// Construct a parse error from any displayable message.
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

/// A failure executing a parsed query against the index.
#[derive(Debug, thiserror::Error)]
pub enum QueryError {
    /// The underlying libSQL driver returned an error.
    #[error("database error: {0}")]
    Db(#[from] libsql::Error),
    /// An index-layer error (e.g. opening the connection).
    #[error("index error: {0}")]
    Index(#[from] cubical_index::IndexError),
}
```

- [ ] **Step 2: Add `mod error;` + `pub use error::{ParseError, QueryError};` to `lib.rs`.**

- [ ] **Step 3: Build**

Run: `cargo build -p cubical-query`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-query/
git commit -m "feat(l4d): query error types"
```

---

### Task 4: Parser — tokenizer + grammar (TDD, incremental)

**Files:**
- Create: `crates/cubical-query/src/parser.rs`

The parser is built test-first, one grammar feature per cycle. Each test uses an input that exercises only its feature, so its asserted AST stays stable as later features land.

- [ ] **Step 1: Write the failing test for the minimal `LIST`**

`crates/cubical-query/src/parser.rs` (start the file):

```rust
//! Hand-written tokenizer + recursive-descent parser for the query DSL.
//!
//! Grammar (clause order fixed):
//! `<command> [FROM <source>] [WHERE <cond> {AND <cond>}] [SORT <key> [ASC|DESC]]`
//! Keywords are case-insensitive. See the design spec §3.

use crate::ast::{Command, Cond, Op, Query, Sort, SortDir, Source, Value};
use crate::error::ParseError;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_list() {
        let q = parse("LIST").unwrap();
        assert_eq!(q.command, Command::List);
        assert_eq!(q.source, None);
        assert!(q.conds.is_empty());
        assert_eq!(q.sort, None);
    }
}
```

- [ ] **Step 2: Run it — fails to compile (`parse` undefined)**

Run: `cargo test -p cubical-query parses_bare_list`
Expected: FAIL (cannot find function `parse`).

- [ ] **Step 3: Implement the tokenizer + a `parse` covering `LIST`/`COUNT`/`TABLE`**

Add above the `tests` module:

```rust
/// A lexical token.
#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// A bare word (keyword or identifier), lowercased copy kept for
    /// keyword matching; original kept for identifiers.
    Word(String),
    /// A double-quoted string literal (contents, unescaped).
    Str(String),
    /// A numeric literal.
    Num(f64),
    /// `#tag` token (the part after `#`).
    Tag(String),
    /// One of `=`, `!=`, `<`, `<=`, `>`, `>=`.
    Op(Op),
    /// `,`
    Comma,
}

fn tokenize(src: &str) -> Result<Vec<Tok>, ParseError> {
    let mut out = Vec::new();
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            c if c.is_whitespace() => i += 1,
            ',' => { out.push(Tok::Comma); i += 1; }
            '=' => { out.push(Tok::Op(Op::Eq)); i += 1; }
            '!' => {
                if chars.get(i + 1) == Some(&'=') {
                    out.push(Tok::Op(Op::Ne)); i += 2;
                } else {
                    return Err(ParseError::new("expected `=` after `!`"));
                }
            }
            '<' => {
                if chars.get(i + 1) == Some(&'=') { out.push(Tok::Op(Op::Le)); i += 2; }
                else { out.push(Tok::Op(Op::Lt)); i += 1; }
            }
            '>' => {
                if chars.get(i + 1) == Some(&'=') { out.push(Tok::Op(Op::Ge)); i += 2; }
                else { out.push(Tok::Op(Op::Gt)); i += 1; }
            }
            '"' => {
                let mut s = String::new();
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(ParseError::new("unterminated string literal")),
                        Some('"') => { i += 1; break; }
                        Some(&ch) => { s.push(ch); i += 1; }
                    }
                }
                out.push(Tok::Str(s));
            }
            '#' => {
                i += 1;
                let start = i;
                while i < chars.len() && (chars[i].is_alphanumeric() || matches!(chars[i], '/' | '-' | '_')) {
                    i += 1;
                }
                if i == start { return Err(ParseError::new("expected a tag after `#`")); }
                out.push(Tok::Tag(chars[start..i].iter().collect()));
            }
            c if c.is_ascii_digit() || (c == '-' && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit())) => {
                let start = i;
                i += 1;
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') { i += 1; }
                let raw: String = chars[start..i].iter().collect();
                let n = raw.parse::<f64>().map_err(|_| ParseError::new(format!("invalid number `{raw}`")))?;
                out.push(Tok::Num(n));
            }
            c if c.is_alphabetic() || c == '_' => {
                let start = i;
                while i < chars.len() && (chars[i].is_alphanumeric() || matches!(chars[i], '_' | '-' | '.')) {
                    i += 1;
                }
                out.push(Tok::Word(chars[start..i].iter().collect()));
            }
            other => return Err(ParseError::new(format!("unexpected character `{other}`"))),
        }
    }
    Ok(out)
}

/// Parse query source into a [`Query`].
pub fn parse(src: &str) -> Result<Query, ParseError> {
    let toks = tokenize(src)?;
    let mut p = Parser { toks, pos: 0 };
    let q = p.parse_query()?;
    if p.pos != p.toks.len() {
        return Err(ParseError::new("unexpected trailing input"));
    }
    Ok(q)
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> { self.toks.get(self.pos) }
    fn bump(&mut self) -> Option<Tok> { let t = self.toks.get(self.pos).cloned(); if t.is_some() { self.pos += 1; } t }

    /// Consume a `Word` matching `kw` (case-insensitive). Returns true if consumed.
    fn eat_kw(&mut self, kw: &str) -> bool {
        if let Some(Tok::Word(w)) = self.peek() {
            if w.eq_ignore_ascii_case(kw) { self.pos += 1; return true; }
        }
        false
    }

    fn parse_query(&mut self) -> Result<Query, ParseError> {
        let command = self.parse_command()?;
        let source = self.parse_from()?;
        let conds = self.parse_where()?;
        let sort = self.parse_sort()?;
        Ok(Query { command, source, conds, sort })
    }

    fn parse_command(&mut self) -> Result<Command, ParseError> {
        match self.bump() {
            Some(Tok::Word(w)) if w.eq_ignore_ascii_case("list") => Ok(Command::List),
            Some(Tok::Word(w)) if w.eq_ignore_ascii_case("count") => Ok(Command::Count),
            Some(Tok::Word(w)) if w.eq_ignore_ascii_case("table") => {
                let cols = self.parse_column_list()?;
                Ok(Command::Table(cols))
            }
            _ => Err(ParseError::new("expected LIST, TABLE, or COUNT")),
        }
    }

    fn parse_column_list(&mut self) -> Result<Vec<String>, ParseError> {
        let mut cols = Vec::new();
        loop {
            match self.peek() {
                Some(Tok::Word(w)) => { cols.push(w.clone()); self.pos += 1; }
                _ => return Err(ParseError::new("expected a column name after TABLE")),
            }
            if matches!(self.peek(), Some(Tok::Comma)) { self.pos += 1; } else { break; }
        }
        Ok(cols)
    }

    // parse_from / parse_where / parse_sort land in later steps; stub them
    // to return the empty case so the file compiles after this step:
    fn parse_from(&mut self) -> Result<Option<Source>, ParseError> { Ok(None) }
    fn parse_where(&mut self) -> Result<Vec<Cond>, ParseError> { Ok(Vec::new()) }
    fn parse_sort(&mut self) -> Result<Option<Sort>, ParseError> { Ok(None) }
}
```

- [ ] **Step 4: Run — passes**

Run: `cargo test -p cubical-query parses_bare_list`
Expected: PASS.

- [ ] **Step 5: Add tests for COUNT + TABLE columns**

In the `tests` module:

```rust
#[test]
fn parses_count() {
    assert_eq!(parse("COUNT").unwrap().command, Command::Count);
    assert_eq!(parse("count").unwrap().command, Command::Count); // case-insensitive
}

#[test]
fn parses_table_columns() {
    let q = parse("TABLE status, due_date").unwrap();
    assert_eq!(q.command, Command::Table(vec!["status".into(), "due_date".into()]));
}

#[test]
fn table_without_columns_errors() {
    assert!(parse("TABLE").is_err());
}
```

Run: `cargo test -p cubical-query` — Expected: PASS (the command parser already handles these).

- [ ] **Step 6: Add FROM tests, then implement `parse_from`**

Tests:

```rust
#[test]
fn parses_from_tag() {
    let q = parse("LIST FROM #project").unwrap();
    assert_eq!(q.source, Some(Source::Tag("project".into())));
}

#[test]
fn parses_from_folder() {
    let q = parse(r#"LIST FROM "areas/health""#).unwrap();
    assert_eq!(q.source, Some(Source::Folder("areas/health".into())));
}
```

Replace the `parse_from` stub:

```rust
fn parse_from(&mut self) -> Result<Option<Source>, ParseError> {
    if !self.eat_kw("from") { return Ok(None); }
    match self.bump() {
        Some(Tok::Tag(t)) => Ok(Some(Source::Tag(t))),
        Some(Tok::Str(s)) => Ok(Some(Source::Folder(s))),
        _ => Err(ParseError::new("expected #tag or \"folder\" after FROM")),
    }
}
```

Run: `cargo test -p cubical-query` — Expected: PASS.

- [ ] **Step 7: Add WHERE tests, then implement `parse_where`**

Tests:

```rust
#[test]
fn parses_where_single_cond() {
    let q = parse(r#"LIST WHERE status = "in-progress""#).unwrap();
    assert_eq!(q.conds, vec![Cond {
        key: "status".into(), op: Op::Eq, value: Value::Str("in-progress".into()),
    }]);
}

#[test]
fn parses_where_and_chain_and_types() {
    let q = parse("LIST WHERE priority >= 2 AND done = true").unwrap();
    assert_eq!(q.conds, vec![
        Cond { key: "priority".into(), op: Op::Ge, value: Value::Num(2.0) },
        Cond { key: "done".into(), op: Op::Eq, value: Value::Bool(true) },
    ]);
}

#[test]
fn where_without_key_errors() {
    assert!(parse("LIST WHERE = 3").is_err());
}
```

Replace the `parse_where` stub:

```rust
fn parse_where(&mut self) -> Result<Vec<Cond>, ParseError> {
    if !self.eat_kw("where") { return Ok(Vec::new()); }
    let mut conds = vec![self.parse_cond()?];
    while self.eat_kw("and") {
        conds.push(self.parse_cond()?);
    }
    Ok(conds)
}

fn parse_cond(&mut self) -> Result<Cond, ParseError> {
    let key = match self.bump() {
        Some(Tok::Word(w)) => w,
        _ => return Err(ParseError::new("expected a frontmatter key in WHERE")),
    };
    let op = match self.bump() {
        Some(Tok::Op(op)) => op,
        _ => return Err(ParseError::new("expected a comparison operator (=, !=, <, <=, >, >=)")),
    };
    let value = self.parse_value()?;
    Ok(Cond { key, op, value })
}

fn parse_value(&mut self) -> Result<Value, ParseError> {
    match self.bump() {
        Some(Tok::Str(s)) => Ok(Value::Str(s)),
        Some(Tok::Num(n)) => Ok(Value::Num(n)),
        Some(Tok::Word(w)) if w.eq_ignore_ascii_case("true") => Ok(Value::Bool(true)),
        Some(Tok::Word(w)) if w.eq_ignore_ascii_case("false") => Ok(Value::Bool(false)),
        _ => Err(ParseError::new("expected a string, number, or true/false")),
    }
}
```

Run: `cargo test -p cubical-query` — Expected: PASS.

- [ ] **Step 8: Add SORT tests, then implement `parse_sort`**

Tests:

```rust
#[test]
fn parses_sort_default_asc() {
    let q = parse("LIST SORT due_date").unwrap();
    assert_eq!(q.sort, Some(Sort { key: "due_date".into(), dir: SortDir::Asc }));
}

#[test]
fn parses_sort_desc() {
    let q = parse("LIST SORT due_date DESC").unwrap();
    assert_eq!(q.sort, Some(Sort { key: "due_date".into(), dir: SortDir::Desc }));
}

#[test]
fn parses_full_query() {
    let q = parse(r#"TABLE status, due_date FROM #project WHERE status = "in-progress" SORT due_date ASC"#).unwrap();
    assert_eq!(q.command, Command::Table(vec!["status".into(), "due_date".into()]));
    assert_eq!(q.source, Some(Source::Tag("project".into())));
    assert_eq!(q.conds.len(), 1);
    assert_eq!(q.sort, Some(Sort { key: "due_date".into(), dir: SortDir::Asc }));
}
```

Replace the `parse_sort` stub:

```rust
fn parse_sort(&mut self) -> Result<Option<Sort>, ParseError> {
    if !self.eat_kw("sort") { return Ok(None); }
    let key = match self.bump() {
        Some(Tok::Word(w)) => w,
        _ => return Err(ParseError::new("expected a frontmatter key after SORT")),
    };
    let dir = if self.eat_kw("desc") { SortDir::Desc }
        else { self.eat_kw("asc"); SortDir::Asc };
    Ok(Some(Sort { key, dir }))
}
```

Run: `cargo test -p cubical-query` — Expected: PASS.

- [ ] **Step 9: Add error-path tests**

```rust
#[test]
fn empty_input_errors() {
    assert!(parse("").is_err());
    assert!(parse("   ").is_err());
}

#[test]
fn unknown_command_errors() {
    assert!(parse("FETCH status").is_err());
}

#[test]
fn trailing_junk_errors() {
    assert!(parse("LIST garbage extra").is_err());
}

#[test]
fn unterminated_string_errors() {
    assert!(parse(r#"LIST WHERE x = "oops"#).is_err());
}
```

Run: `cargo test -p cubical-query` — Expected: PASS. If `LIST garbage` does not error, confirm the trailing-input check in `parse` is reached (a bare `Word` after a command with no clause keyword falls through to the trailing check).

- [ ] **Step 10: Add `mod parser;` + `pub use parser::parse;` to `lib.rs`; full build**

Run: `cargo test -p cubical-query && cargo clippy -p cubical-query --all-targets -- -D warnings`
Expected: green.

- [ ] **Step 11: Commit**

```bash
git add crates/cubical-query/
git commit -m "feat(l4d): query parser (tokenizer + grammar)"
```

---

### Task 5: Planner — AST → parameterized SQL

**Files:**
- Create: `crates/cubical-query/src/plan.rs`

Planner is pure: `Query → Plan { sql, params }`. Tests assert the exact SQL + params for a specific input, so they stay stable. Param order in the produced SQL: TABLE column keys (in SELECT) → FROM tag/folder params → WHERE (key,value) pairs → SORT key.

- [ ] **Step 1: Write the failing test for bare LIST**

`crates/cubical-query/src/plan.rs`:

```rust
//! Compile a [`Query`] into a parameterized SQL string.
//!
//! `frontmatter.value` is JSON-encoded TEXT, so every value comparison
//! and projection goes through `json_extract(value,'$')`, which unwraps
//! to the native SQLite scalar. All literals/keys are bound parameters —
//! never interpolated — so a query block cannot inject SQL.

use crate::ast::{Command, Op, Query, SortDir, Source, Value};

/// A bound SQL parameter, kept driver-agnostic so the planner stays
/// pure and unit-testable; `exec` converts these to `libsql::Value`.
#[derive(Debug, Clone, PartialEq)]
pub enum SqlParam {
    /// A text parameter.
    Text(String),
    /// A real (floating-point) parameter.
    Real(f64),
    /// An integer parameter (also used for booleans: 1/0).
    Int(i64),
}

/// A compiled query: SQL plus its positional parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// The SQL text with `?` placeholders.
    pub sql: String,
    /// Positional parameters, in placeholder order.
    pub params: Vec<SqlParam>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{Cond, Sort};

    #[test]
    fn plans_bare_list() {
        let q = Query { command: Command::List, source: None, conds: vec![], sort: None };
        let p = plan(&q);
        assert_eq!(p.sql, "SELECT files.path FROM files ORDER BY files.path");
        assert!(p.params.is_empty());
    }
}
```

- [ ] **Step 2: Run — fails (`plan` undefined)**

Run: `cargo test -p cubical-query plans_bare_list`
Expected: FAIL.

- [ ] **Step 3: Implement the planner**

Add above the `tests` module:

```rust
fn op_sql(op: Op) -> &'static str {
    match op {
        Op::Eq => "=", Op::Ne => "!=", Op::Lt => "<",
        Op::Le => "<=", Op::Gt => ">", Op::Ge => ">=",
    }
}

fn value_param(v: &Value) -> SqlParam {
    match v {
        Value::Str(s) => SqlParam::Text(s.clone()),
        Value::Num(n) => SqlParam::Real(*n),
        Value::Bool(b) => SqlParam::Int(i64::from(*b)),
    }
}

/// Escape LIKE-special bytes so a folder/tag literal is a safe prefix.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(ch, '\\' | '%' | '_') { out.push('\\'); }
        out.push(ch);
    }
    out
}

/// Compile a query into SQL + parameters.
pub fn plan(q: &Query) -> Plan {
    let mut params: Vec<SqlParam> = Vec::new();

    // SELECT clause.
    let select = match &q.command {
        Command::Count => "SELECT COUNT(*)".to_string(),
        Command::List => "SELECT files.path".to_string(),
        Command::Table(cols) => {
            let mut parts = vec!["files.path".to_string()];
            for col in cols {
                parts.push(
                    "(SELECT json_extract(value,'$') FROM frontmatter \
                     WHERE file_path = files.path AND key = ?)".to_string(),
                );
                params.push(SqlParam::Text(col.clone()));
            }
            format!("SELECT {}", parts.join(", "))
        }
    };

    // WHERE clause: FROM source + conds, AND-joined.
    let mut wheres: Vec<String> = Vec::new();
    match &q.source {
        Some(Source::Tag(t)) => {
            wheres.push(
                "files.path IN (SELECT file_path FROM tags \
                 WHERE LOWER(tag_path) = ? OR LOWER(tag_path) LIKE ? ESCAPE '\\')".to_string(),
            );
            let needle = t.to_lowercase();
            params.push(SqlParam::Text(needle.clone()));
            params.push(SqlParam::Text(format!("{}/%", escape_like(&needle))));
        }
        Some(Source::Folder(f)) => {
            wheres.push("files.path LIKE ? ESCAPE '\\'".to_string());
            let trimmed = f.trim_end_matches('/');
            params.push(SqlParam::Text(format!("{}/%", escape_like(trimmed))));
        }
        None => {}
    }
    for cond in &q.conds {
        wheres.push(format!(
            "EXISTS (SELECT 1 FROM frontmatter f WHERE f.file_path = files.path \
             AND f.key = ? AND json_extract(f.value,'$') {} ?)",
            op_sql(cond.op),
        ));
        params.push(SqlParam::Text(cond.key.clone()));
        params.push(value_param(&cond.value));
    }

    let mut sql = format!("{select} FROM files");
    if !wheres.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&wheres.join(" AND "));
    }

    // ORDER BY (skipped for COUNT).
    if !matches!(q.command, Command::Count) {
        match &q.sort {
            Some(sort) => {
                let dir = match sort.dir { SortDir::Asc => "ASC", SortDir::Desc => "DESC" };
                // Present keys before missing ones, then by value, then path.
                sql.push_str(
                    " ORDER BY (SELECT json_extract(value,'$') FROM frontmatter \
                     WHERE file_path = files.path AND key = ?) IS NULL, \
                     (SELECT json_extract(value,'$') FROM frontmatter \
                     WHERE file_path = files.path AND key = ?) ",
                );
                sql.push_str(dir);
                sql.push_str(", files.path");
                params.push(SqlParam::Text(sort.key.clone()));
                params.push(SqlParam::Text(sort.key.clone()));
            }
            None => sql.push_str(" ORDER BY files.path"),
        }
    }

    Plan { sql, params }
}
```

- [ ] **Step 4: Run — passes**

Run: `cargo test -p cubical-query plans_bare_list`
Expected: PASS.

- [ ] **Step 5: Add planner tests for COUNT, FROM, WHERE, TABLE, SORT**

```rust
#[test]
fn plans_count_has_no_order_by() {
    let q = Query { command: Command::Count, source: None, conds: vec![], sort: None };
    assert_eq!(plan(&q).sql, "SELECT COUNT(*) FROM files");
}

#[test]
fn plans_from_tag() {
    let q = Query {
        command: Command::List,
        source: Some(Source::Tag("Project".into())),
        conds: vec![], sort: None,
    };
    let p = plan(&q);
    assert!(p.sql.contains("files.path IN (SELECT file_path FROM tags"));
    assert_eq!(p.params, vec![
        SqlParam::Text("project".into()),
        SqlParam::Text("project/%".into()),
    ]);
}

#[test]
fn plans_where_uses_json_extract_and_typed_params() {
    let q = Query {
        command: Command::List, source: None,
        conds: vec![
            Cond { key: "priority".into(), op: Op::Ge, value: Value::Num(2.0) },
            Cond { key: "done".into(), op: Op::Eq, value: Value::Bool(true) },
        ],
        sort: None,
    };
    let p = plan(&q);
    assert!(p.sql.contains("json_extract(f.value,'$') >= ?"));
    assert!(p.sql.contains(" AND EXISTS"));
    assert_eq!(p.params, vec![
        SqlParam::Text("priority".into()), SqlParam::Real(2.0),
        SqlParam::Text("done".into()), SqlParam::Int(1),
    ]);
}

#[test]
fn plans_table_columns_as_scalar_subqueries() {
    let q = Query {
        command: Command::Table(vec!["status".into()]),
        source: None, conds: vec![], sort: None,
    };
    let p = plan(&q);
    assert!(p.sql.starts_with("SELECT files.path, (SELECT json_extract(value,'$')"));
    assert_eq!(p.params, vec![SqlParam::Text("status".into())]);
}

#[test]
fn plans_sort_orders_missing_keys_last() {
    let q = Query {
        command: Command::List, source: None, conds: vec![],
        sort: Some(Sort { key: "due_date".into(), dir: SortDir::Desc }),
    };
    let p = plan(&q);
    assert!(p.sql.contains("IS NULL, "));
    assert!(p.sql.contains(") DESC, files.path"));
    assert_eq!(p.params, vec![
        SqlParam::Text("due_date".into()),
        SqlParam::Text("due_date".into()),
    ]);
}
```

Run: `cargo test -p cubical-query` — Expected: PASS. Adjust the asserted substrings to match your exact whitespace if any test fails on formatting (the SQL content, not spacing, is what matters).

- [ ] **Step 6: Add `mod plan;` to `lib.rs` (keep `plan`/`Plan`/`SqlParam` crate-internal — no `pub use` needed yet); clippy**

Run: `cargo clippy -p cubical-query --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add crates/cubical-query/
git commit -m "feat(l4d): query planner (AST to parameterized SQL)"
```

---

### Task 6: Executor — run plan against the index

**Files:**
- Create: `crates/cubical-query/src/exec.rs`

- [ ] **Step 1: Write the failing test for LIST + COUNT against a seeded in-memory-ish index**

`crates/cubical-query/src/exec.rs`:

```rust
//! Execute a parsed [`Query`] against an open index connection.

use cubical_index::IndexConn;
use libsql::Value as SqlValue;
use serde::Serialize;

use crate::ast::{Command, Query};
use crate::error::QueryError;
use crate::plan::{plan, SqlParam};

/// A reference to a note in a result.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NoteRef {
    /// Vault-relative path.
    pub path: String,
    /// Display title (filename stem — no `# H1` injection).
    pub title: String,
}

/// One row of a `TABLE` result.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Row {
    /// The note this row is about (the implicit first column).
    pub note: NoteRef,
    /// The projected cell values, in column order; empty string if the
    /// frontmatter key is absent.
    pub cells: Vec<String>,
}

/// The shaped result of a query.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueryResult {
    /// `LIST` — note links.
    List {
        /// Matching notes.
        notes: Vec<NoteRef>,
    },
    /// `TABLE` — columns + rows.
    Table {
        /// Column headers (the named frontmatter keys; the file column is implicit).
        columns: Vec<String>,
        /// Result rows.
        rows: Vec<Row>,
    },
    /// `COUNT` — a single number.
    Count {
        /// Number of matching files.
        count: usize,
    },
}

fn title_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

fn to_sql_values(params: &[SqlParam]) -> Vec<SqlValue> {
    params.iter().map(|p| match p {
        SqlParam::Text(s) => SqlValue::Text(s.clone()),
        SqlParam::Real(f) => SqlValue::Real(*f),
        SqlParam::Int(i) => SqlValue::Integer(*i),
    }).collect()
}

/// Render a libSQL cell value as display text. NULL / missing → "".
fn cell_text(v: &SqlValue) -> String {
    match v {
        SqlValue::Null => String::new(),
        SqlValue::Integer(i) => i.to_string(),
        SqlValue::Real(f) => f.to_string(),
        SqlValue::Text(s) => s.clone(),
        SqlValue::Blob(_) => String::new(),
    }
}

/// Execute `q` against `conn`, returning the shaped result.
pub async fn run(conn: &IndexConn, q: &Query) -> Result<QueryResult, QueryError> {
    let p = plan(q);
    let params = to_sql_values(&p.params);
    let c = conn.connection();

    match &q.command {
        Command::Count => {
            let mut rows = c.query(&p.sql, params).await?;
            let count = match rows.next().await? {
                Some(row) => row.get::<i64>(0)? as usize,
                None => 0,
            };
            Ok(QueryResult::Count { count })
        }
        Command::List => {
            let mut rows = c.query(&p.sql, params).await?;
            let mut notes = Vec::new();
            while let Some(row) = rows.next().await? {
                let path: String = row.get(0)?;
                let title = title_of(&path);
                notes.push(NoteRef { path, title });
            }
            Ok(QueryResult::List { notes })
        }
        Command::Table(cols) => {
            let mut rows = c.query(&p.sql, params).await?;
            let mut out = Vec::new();
            while let Some(row) = rows.next().await? {
                let path: String = row.get(0)?;
                let note = NoteRef { title: title_of(&path), path };
                let mut cells = Vec::with_capacity(cols.len());
                for i in 0..cols.len() {
                    let v = row.get_value((i + 1) as i32)?;
                    cells.push(cell_text(&v));
                }
                out.push(Row { note, cells });
            }
            Ok(QueryResult::Table { columns: cols.clone(), rows: out })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;
    use cubical_index::open_index;
    use tempfile::tempdir;

    async fn seed() -> (tempfile::TempDir, IndexConn) {
        let dir = tempdir().unwrap();
        let conn = open_index(&dir.path().join("index.db")).await.unwrap();
        let c = conn.connection();
        for (path, status, prio) in [
            ("a.md", "\"in-progress\"", "3"),
            ("b.md", "\"done\"", "1"),
            ("c.md", "\"in-progress\"", "2"),
        ] {
            c.execute(
                "INSERT INTO files (path, type_id, size_bytes, mtime_unix, content_hash, \
                 inode, last_seen, created_at, updated_at) \
                 VALUES (?1, 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                libsql::params![path],
            ).await.unwrap();
            c.execute(
                "INSERT INTO frontmatter (file_path, key, value) VALUES (?1, 'status', ?2)",
                libsql::params![path, status],
            ).await.unwrap();
            c.execute(
                "INSERT INTO frontmatter (file_path, key, value) VALUES (?1, 'priority', ?2)",
                libsql::params![path, prio],
            ).await.unwrap();
        }
        (dir, conn)
    }

    #[tokio::test]
    async fn list_all() {
        let (_d, conn) = seed().await;
        let r = run(&conn, &parse("LIST").unwrap()).await.unwrap();
        match r {
            QueryResult::List { notes } => {
                let paths: Vec<_> = notes.iter().map(|n| n.path.as_str()).collect();
                assert_eq!(paths, vec!["a.md", "b.md", "c.md"]);
                assert_eq!(notes[0].title, "a");
            }
            _ => panic!("expected list"),
        }
    }

    #[tokio::test]
    async fn count_with_where() {
        let (_d, conn) = seed().await;
        let q = parse(r#"COUNT WHERE status = "in-progress""#).unwrap();
        match run(&conn, &q).await.unwrap() {
            QueryResult::Count { count } => assert_eq!(count, 2),
            _ => panic!("expected count"),
        }
    }
}
```

> Confirm the libSQL row accessor names against `cubical-index`'s usage: the codebase uses `row.get(i)` (typed). For a dynamic cell whose type is unknown at compile time, use `row.get_value(i)` if available in the pinned libsql version; if the method is named differently (e.g. `get::<libsql::Value>(i)`), adjust `cell_text`'s call site accordingly. Verify with `cargo doc -p libsql` or by grepping existing usage.

- [ ] **Step 2: Run — fails (module/function undefined until wired)**

Run: `cargo test -p cubical-query list_all`
Expected: FAIL (then PASS once `mod exec;` + `pub use` are added).

- [ ] **Step 3: Add `mod exec;` + `pub use exec::{run, NoteRef, QueryResult, Row};` to `lib.rs`**

- [ ] **Step 4: Run the exec tests**

Run: `cargo test -p cubical-query`
Expected: PASS. If `get_value` does not exist, apply the accessor fix noted above and re-run.

- [ ] **Step 5: Add tests for ordered comparison, sort, table cells, tag source, and missing key**

```rust
#[tokio::test]
async fn numeric_comparison_is_numeric_not_lexical() {
    let (_d, conn) = seed().await;
    // priority >= 2 → a(3), c(2); not b(1). Proves CAST/json numeric compare.
    let q = parse("LIST WHERE priority >= 2 SORT priority DESC").unwrap();
    match run(&conn, &q).await.unwrap() {
        QueryResult::List { notes } => {
            let paths: Vec<_> = notes.iter().map(|n| n.path.as_str()).collect();
            assert_eq!(paths, vec!["a.md", "c.md"]); // 3 then 2
        }
        _ => panic!(),
    }
}

#[tokio::test]
async fn table_projects_cells_and_empty_for_missing_key() {
    let (_d, conn) = seed().await;
    // 'note' key exists on none of the seeded files → empty cell.
    let q = parse("TABLE status, note").unwrap();
    match run(&conn, &q).await.unwrap() {
        QueryResult::Table { columns, rows } => {
            assert_eq!(columns, vec!["status".to_string(), "note".to_string()]);
            assert_eq!(rows[0].note.path, "a.md");
            assert_eq!(rows[0].cells, vec!["in-progress".to_string(), "".to_string()]);
        }
        _ => panic!(),
    }
}
```

> The `status` cell asserts `"in-progress"` (unquoted) — proof that `json_extract` unwrapped the JSON string. If you instead see `"\"in-progress\""`, the planner is not extracting; fix the planner, not the test.

Run: `cargo test -p cubical-query` — Expected: PASS.

- [ ] **Step 6: Full crate gate**

Run: `cargo test -p cubical-query && cargo clippy -p cubical-query --all-targets -- -D warnings && cargo fmt -p cubical-query -- --check`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add crates/cubical-query/
git commit -m "feat(l4d): query executor (plan -> shaped result)"
```

---

## Phase 2 — IPC (`cubical-app`)

### Task 7: Wire types + crate dependency

**Files:**
- Modify: `crates/cubical-app/Cargo.toml`
- Modify: `crates/cubical-app/src/api/types.rs`

- [ ] **Step 1: Add the dependency**

In `crates/cubical-app/Cargo.toml` `[dependencies]`, alongside the other `cubical-*` path deps:

```toml
cubical-query = { path = "../cubical-query" }
```

- [ ] **Step 2: Add request + result DTOs**

Append to `crates/cubical-app/src/api/types.rs` (match the existing `#[derive(...)]` + `serde` conventions in that file):

```rust
/// Request for the `dataview_query` command.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DataviewQueryRequest {
    /// Which open vault to query.
    pub vault_id: String,
    /// The raw query source from the ```query fence.
    pub source: String,
}

/// Result of a `dataview_query` — always `Ok`; a bad query is reported
/// in the `error` variant so the renderer always gets a structured answer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DataviewResult {
    /// `LIST` — note links.
    List {
        /// Matching notes.
        notes: Vec<cubical_query::NoteRef>,
    },
    /// `TABLE` — columns + rows.
    Table {
        /// Column headers.
        columns: Vec<String>,
        /// Result rows.
        rows: Vec<cubical_query::Row>,
    },
    /// `COUNT`.
    Count {
        /// Number of matching files.
        count: usize,
    },
    /// A parse or execution error, phrased for display.
    Error {
        /// The error message.
        message: String,
    },
}

impl From<cubical_query::QueryResult> for DataviewResult {
    fn from(r: cubical_query::QueryResult) -> Self {
        match r {
            cubical_query::QueryResult::List { notes } => Self::List { notes },
            cubical_query::QueryResult::Table { columns, rows } => Self::Table { columns, rows },
            cubical_query::QueryResult::Count { count } => Self::Count { count },
        }
    }
}
```

- [ ] **Step 3: Build**

Run: `cargo build -p cubical-app`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-app/Cargo.toml crates/cubical-app/src/api/types.rs
git commit -m "feat(l4d): dataview IPC DTOs + cubical-query dep"
```

---

### Task 8: Command handler

**Files:**
- Create: `crates/cubical-app/src/commands/dataview.rs`
- Modify: `crates/cubical-app/src/commands/mod.rs`

- [ ] **Step 1: Write the handler with tests**

`crates/cubical-app/src/commands/dataview.rs`:

```rust
//! Pure async handler for the `dataview_query` command.
//!
//! Parses + runs a ```query block against the named vault's index.
//! Parse and execution failures are folded into `DataviewResult::Error`
//! (the command still returns `Ok`) so the editor widget always renders
//! a structured answer rather than a thrown IPC error. Only
//! vault-not-open is a hard error.

use crate::api::types::{DataviewQueryRequest, DataviewResult};
use crate::error::CubicalError;
use crate::state::AppState;

/// Evaluate a Dataview query against the named vault.
pub async fn dataview_query(
    state: &AppState,
    req: DataviewQueryRequest,
) -> Result<DataviewResult, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let query = match cubical_query::parse(&req.source) {
        Ok(q) => q,
        Err(e) => return Ok(DataviewResult::Error { message: e.to_string() }),
    };
    match cubical_query::run(open.vault.index(), &query).await {
        Ok(result) => Ok(result.into()),
        Err(e) => Ok(DataviewResult::Error { message: e.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AppState, OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    async fn fresh_state_with_vault(vault_id: &str) -> (TempDir, Vault, AppState) {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault::new(vault.clone(), CancellationToken::new(), ScanStatusBackend::Complete, None),
        );
        (dir, vault, state)
    }

    async fn seed(vault: &Vault, path: &str, status_json: &str) {
        let c = vault.index().connection();
        c.execute(
            "INSERT INTO files (path, type_id, size_bytes, mtime_unix, content_hash, \
             inode, last_seen, created_at, updated_at) VALUES (?1,'markdown',0,0,'',NULL,0,0,0)",
            libsql::params![path],
        ).await.unwrap();
        c.execute(
            "INSERT INTO frontmatter (file_path, key, value) VALUES (?1,'status',?2)",
            libsql::params![path, status_json],
        ).await.unwrap();
    }

    #[tokio::test]
    async fn count_matches() {
        let (_d, vault, state) = fresh_state_with_vault("v1").await;
        seed(&vault, "a.md", "\"in-progress\"").await;
        seed(&vault, "b.md", "\"done\"").await;
        let req = DataviewQueryRequest {
            vault_id: "v1".into(),
            source: r#"COUNT WHERE status = "in-progress""#.into(),
        };
        match dataview_query(&state, req).await.unwrap() {
            DataviewResult::Count { count } => assert_eq!(count, 1),
            other => panic!("expected count, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn bad_query_returns_error_variant_not_err() {
        let (_d, _vault, state) = fresh_state_with_vault("v1").await;
        let req = DataviewQueryRequest { vault_id: "v1".into(), source: "FETCH stuff".into() };
        match dataview_query(&state, req).await.unwrap() {
            DataviewResult::Error { message } => assert!(!message.is_empty()),
            other => panic!("expected error variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unknown_vault_errors() {
        let (_d, _vault, state) = fresh_state_with_vault("v1").await;
        let req = DataviewQueryRequest { vault_id: "ghost".into(), source: "LIST".into() };
        let err = dataview_query(&state, req).await.expect_err("vault-not-open");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }
}
```

- [ ] **Step 2: Register the module** — add `pub mod dataview;` to `crates/cubical-app/src/commands/mod.rs` (alphabetical, before `embeds`).

- [ ] **Step 3: Run handler tests**

Run: `cargo test -p cubical-app dataview`
Expected: PASS. If `OpenVault::new`'s signature differs from the tags test's, copy the exact call from `crates/cubical-app/src/commands/tags.rs` tests.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-app/src/commands/
git commit -m "feat(l4d): dataview_query command handler"
```

---

### Task 9: Tauri shim + handler registration

**Files:**
- Modify: `crates/cubical-app/src/lib.rs`

- [ ] **Step 1: Add the shim** — near the other command shims in `lib.rs`, mirroring the `search` shim exactly:

```rust
/// Tauri shim — see [`commands::dataview::dataview_query`].
#[tauri::command]
async fn dataview_query(
    state: tauri::State<'_, AppState>,
    req: DataviewQueryRequest,
) -> Result<DataviewResult, CubicalError> {
    commands::dataview::dataview_query(state.inner(), req).await
}
```

Ensure `DataviewQueryRequest` and `DataviewResult` are imported at the top of `lib.rs` alongside the other `crate::api::types::*` imports (check how `SearchRequest` is brought in and follow it).

- [ ] **Step 2: Register in `generate_handler!`** — add `dataview_query,` to the macro list (after `search_get_health,`).

- [ ] **Step 3: Build the whole workspace**

Run: `cargo build --workspace`
Expected: compiles. A missing import or unregistered command shows here.

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-app/src/lib.rs
git commit -m "feat(l4d): register dataview_query Tauri command"
```

---

## Phase 3 — Frontend

### Task 10: IPC wrapper + shape smoke

**Files:**
- Modify: `ui/src/api/ipc.ts`
- Create: `ui/src/api/dataview.test.ts`

- [ ] **Step 1: Write the failing shape test**

`ui/src/api/dataview.test.ts` (mirror `ui/src/api/search.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { dataviewQuery, type DataviewQueryRequest } from "./ipc";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

describe("dataviewQuery ipc wrapper", () => {
  beforeEach(() => mockInvoke.mockReset());

  it("forwards to the `dataview_query` command with `{ req: { vault_id, source } }`", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "count", count: 3 });
    const req: DataviewQueryRequest = { vault_id: "v1", source: "COUNT" };
    const res = await dataviewQuery(req);
    expect(res).toEqual({ kind: "count", count: 3 });
    expect(mockInvoke).toHaveBeenCalledWith("dataview_query", {
      req: { vault_id: "v1", source: "COUNT" },
    });
  });

  it("passes through the error variant", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "error", message: "boom" });
    const res = await dataviewQuery({ vault_id: "v1", source: "FETCH x" });
    expect(res).toEqual({ kind: "error", message: "boom" });
  });
});
```

- [ ] **Step 2: Run — fails (`dataviewQuery` undefined)**

Run: `npx vitest run ui/src/api/dataview.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the wrapper + types to `ui/src/api/ipc.ts`**

```ts
export interface NoteRef {
  path: string;
  title: string;
}

export interface DataviewRow {
  note: NoteRef;
  cells: string[];
}

export type DataviewResult =
  | { kind: "list"; notes: NoteRef[] }
  | { kind: "table"; columns: string[]; rows: DataviewRow[] }
  | { kind: "count"; count: number }
  | { kind: "error"; message: string };

export interface DataviewQueryRequest {
  vault_id: string;
  source: string;
}

/** Evaluate a ```query block against a vault. Never throws for a bad
 *  query — failures arrive as `{ kind: "error" }`. */
export async function dataviewQuery(
  req: DataviewQueryRequest,
): Promise<DataviewResult> {
  return invoke<DataviewResult>("dataview_query", { req });
}
```

- [ ] **Step 4: Run — passes**

Run: `npx vitest run ui/src/api/dataview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/ipc.ts ui/src/api/dataview.test.ts
git commit -m "feat(l4d): dataviewQuery IPC wrapper + shape smoke"
```

---

### Task 11: Pure renderer (`dataviewRender.ts`)

**Files:**
- Create: `ui/src/dataview/dataviewRender.ts`
- Create: `ui/src/dataview/dataviewRender.test.ts`

This is the testable heart of the frontend. It builds a `DocumentFragment` from a `DataviewResult`, mirroring `ui/src/editor/embedRender.ts`'s pure-DOM approach. Note links call an injected `onOpen(path)` so the renderer stays free of editor coupling.

- [ ] **Step 1: Write failing tests**

`ui/src/dataview/dataviewRender.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { renderDataview } from "./dataviewRender";
import type { DataviewResult } from "../api/ipc";

function mount(result: DataviewResult, onOpen = vi.fn()) {
  const host = document.createElement("div");
  host.appendChild(renderDataview(result, { onOpen }));
  return host;
}

describe("renderDataview", () => {
  it("renders a list of note links", () => {
    const onOpen = vi.fn();
    const host = mount(
      { kind: "list", notes: [{ path: "a.md", title: "a" }, { path: "b.md", title: "b" }] },
      onOpen,
    );
    const links = host.querySelectorAll("a");
    expect(links.length).toBe(2);
    expect(links[0].textContent).toBe("a");
    links[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith("a.md");
  });

  it("renders a table with an implicit file column + cells", () => {
    const host = mount({
      kind: "table",
      columns: ["status", "due"],
      rows: [{ note: { path: "a.md", title: "a" }, cells: ["in-progress", ""] }],
    });
    const headers = [...host.querySelectorAll("th")].map((h) => h.textContent);
    expect(headers).toEqual(["File", "status", "due"]);
    const cells = [...host.querySelectorAll("tbody td")].map((c) => c.textContent);
    expect(cells).toEqual(["a", "in-progress", ""]);
    expect(host.querySelector("tbody td a")?.textContent).toBe("a");
  });

  it("renders a count", () => {
    const host = mount({ kind: "count", count: 7 });
    expect(host.textContent).toContain("7");
  });

  it("renders an error", () => {
    const host = mount({ kind: "error", message: "expected LIST, TABLE, or COUNT" });
    expect(host.querySelector(".cq-dataview-error")?.textContent).toContain("expected LIST");
  });
});
```

- [ ] **Step 2: Run — fails**

Run: `npx vitest run ui/src/dataview/dataviewRender.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the renderer**

`ui/src/dataview/dataviewRender.ts`:

```ts
/**
 * Pure DOM renderer for a Dataview query result (L4-D).
 *
 * The CodeMirror block widget is a thin host; this module builds the
 * fragment, mirroring `editor/embedRender.ts`. No markdown parsing —
 * cells render as plain text. Note links call `ctx.onOpen(path)` so the
 * renderer has no editor dependency.
 */
import type { DataviewResult } from "../api/ipc";

export interface RenderDataviewCtx {
  /** Invoked when a note link is clicked. */
  onOpen: (path: string) => void;
}

function noteLink(path: string, title: string, ctx: RenderDataviewCtx): HTMLAnchorElement {
  const a = document.createElement("a");
  a.textContent = title;
  a.className = "cq-dataview-link";
  a.href = "#";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.onOpen(path);
  });
  return a;
}

export function renderDataview(
  result: DataviewResult,
  ctx: RenderDataviewCtx,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (result.kind === "error") {
    const div = document.createElement("div");
    div.className = "cq-dataview-error";
    div.textContent = `⚠ ${result.message}`;
    frag.appendChild(div);
    return frag;
  }

  if (result.kind === "count") {
    const div = document.createElement("div");
    div.className = "cq-dataview-count";
    div.textContent = String(result.count);
    frag.appendChild(div);
    return frag;
  }

  if (result.kind === "list") {
    const ul = document.createElement("ul");
    ul.className = "cq-dataview-list";
    for (const n of result.notes) {
      const li = document.createElement("li");
      li.appendChild(noteLink(n.path, n.title, ctx));
      ul.appendChild(li);
    }
    frag.appendChild(ul);
    return frag;
  }

  // table
  const table = document.createElement("table");
  table.className = "cq-dataview-table";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const h of ["File", ...result.columns]) {
    const th = document.createElement("th");
    th.textContent = h;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of result.rows) {
    const tr = document.createElement("tr");
    const fileTd = document.createElement("td");
    fileTd.appendChild(noteLink(row.note.path, row.note.title, ctx));
    tr.appendChild(fileTd);
    for (const cell of row.cells) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  frag.appendChild(table);
  return frag;
}
```

- [ ] **Step 4: Run — passes**

Run: `npx vitest run ui/src/dataview/dataviewRender.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/dataview/
git commit -m "feat(l4d): pure dataview result renderer + jsdom tests"
```

---

### Task 12: Editor block widget (operator-smoke / Contract E)

**Files:**
- Create: `ui/src/editor/dataview.ts`
- Modify: `ui/src/editor/livePreview.ts`

The live widget (fence detection, cursor reveal, async fetch, re-eval on `searchRefreshTick`) is operator-smoke-only per the design spec — the tested logic already lives in `dataviewRender.ts`. Model this file on `ui/src/editor/embed.ts` (`buildDecorations` scanning `syntaxTree` for fenced code, a `WidgetType` subclass, a `StateField<DecorationSet>`, a resolver `Facet`, and a `StateEffect` for refresh).

- [ ] **Step 1: Write a minimal guard test**

`ui/src/editor/dataview.ts` will export `dataviewBlockField` and `dataviewBaseTheme`. Add to an existing editor test file or a new `ui/src/editor/dataview.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { dataviewExtension } from "./dataview";

describe("dataviewExtension", () => {
  it("is a non-empty extension array", () => {
    expect(Array.isArray(dataviewExtension)).toBe(true);
    expect((dataviewExtension as unknown[]).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — fails**

Run: `npx vitest run ui/src/editor/dataview.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the widget, modeled on `embed.ts`**

Create `ui/src/editor/dataview.ts`. Read `ui/src/editor/embed.ts` in full and adapt:
- A `dataviewQueryFacet` providing `{ run: (source) => Promise<DataviewResult>, onOpen: (path) => void, refreshTick: () => number }` (the App wires `run` to `dataviewQuery({ vault_id, source })` and `onOpen` to the existing note-open path used by wiki-links).
- `buildDecorations(state)` walks `syntaxTree`, finds `FencedCode` nodes whose info string is `query`, and (when the cursor is outside the node's line range) emits `Decoration.replace({ widget, block: true })`. When the cursor is inside, emit nothing so the raw source shows — identical to `embed.ts`'s cursor handling.
- `class DataviewWidget extends WidgetType` whose `toDOM()` creates a wrapper, shows a "Loading…" placeholder, calls `facet.run(source)`, then replaces the placeholder via `renderDataview(result, { onOpen })` from `../dataview/dataviewRender`. `eq(other)` compares the source string so unchanged blocks are not rebuilt.
- A `StateField<DecorationSet>` (`dataviewBlockField`) rebuilding on doc/selection change and on a `dataviewRefresh` `StateEffect`. The App dispatches that effect when `searchRefreshTick` changes (same signal embeds already react to).
- `dataviewBaseTheme = EditorView.baseTheme({ ... })` styling `.cq-dataview-table`, `.cq-dataview-list`, `.cq-dataview-error`, `.cq-dataview-count`.
- `export const dataviewExtension: Extension = [dataviewBlockField, dataviewBaseTheme];`

> Caching/coalescing: keep a per-`EditorView` `Map<sourceString, DataviewResult>` so re-renders don't re-invoke IPC; clear it on the `dataviewRefresh` effect. This mirrors `embedResolver`.

- [ ] **Step 4: Add to the bundle** — in `ui/src/editor/livePreview.ts`, import `dataviewBlockField, dataviewBaseTheme` (or `dataviewExtension`) and add them to the `livePreviewBundle` array next to the embed entries.

- [ ] **Step 5: Run the guard test + tsc**

Run: `npx vitest run ui/src/editor/dataview.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 6: Wire the facet in `Editor.tsx` / `App.tsx`**

Provide `dataviewQueryFacet.of({ run, onOpen, ... })` where the editor is constructed (near where `embedResolverFacet` is provided). `run` calls `dataviewQuery({ vault_id: <current>, source })`; `onOpen` reuses the existing wiki-link open handler. Dispatch the `dataviewRefresh` effect in the same place the editor reacts to `searchRefreshTick`.

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add ui/src/editor/dataview.ts ui/src/editor/dataview.test.ts ui/src/editor/livePreview.ts ui/src/Editor.tsx ui/src/App.tsx
git commit -m "feat(l4d): editor ```query block widget (live preview)"
```

---

## Phase 4 — Verify, smoke, close

### Task 13: Full gate run

- [ ] **Step 1: Run all six gates**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
npx tsc --noEmit
npx vitest run
npm run build
```
Expected: all green. Fix any failure before proceeding — do not paper over.

- [ ] **Step 2: Commit any fmt/lint fixups**

```bash
git add -A && git commit -m "chore(l4d): gate fixups"
```

### Task 14: Operator smoke (manual, recorded)

- [ ] **Step 1: Build/run the app on a vault containing notes with frontmatter** (`status`, `priority`, `due_date`) and at least one tagged `#project`.

- [ ] **Step 2: In a note, add and verify each block renders:**

````markdown
```query
TABLE status, due_date FROM #project WHERE status = "in-progress" SORT due_date ASC
```
````
````markdown
```query
LIST WHERE priority >= 2
```
````
````markdown
```query
COUNT WHERE done = true
```
````
````markdown
```query
TABLE oops WHERE  (bad syntax)
```
````

Verify: table/list/count render; clicking a note link navigates; placing the cursor inside the block reveals the raw fence; editing a referenced note elsewhere updates the result (re-eval on `searchRefreshTick`); the bad query shows the ⚠ error message (not a blank/crash).

- [ ] **Step 3: Record the smoke pass** in the design spec (add a "§ Operator smoke" note with date + what was verified, honest about anything not exercised), per the L4 Contract E convention used in `docs/layer-4-spec.md` §9.

### Task 15: Documentation + layer bookkeeping

- [ ] **Step 1: Update `docs/layer-4-spec.md`** — tick the L4-D box in §6; add an L4-D closeout subsection under §9 (what landed, tests, gate results, decisions), mirroring §9.3/§9.4.

- [ ] **Step 2: Update `CLAUDE.md` Project state block** — rewrite (don't append) to reflect L4-D landed and the remaining L4 layer-close items (per the kickoff "After L4-D" section). Update the test counts.

- [ ] **Step 3: Commit docs**

```bash
git add docs/layer-4-spec.md CLAUDE.md docs/superpowers/specs/2026-06-14-l4-d-dataview-design.md
git commit -m "docs(l4d): closeout — spec, layer-4 rollup, project state"
```

- [ ] **Step 4: Finish the branch** — use the `superpowers:finishing-a-development-branch` skill to merge `feat/l4d-dataview` to `main` and tag `l4d`. (The L4 layer-close smoke + `l4` tag is a separate follow-up session per the kickoff.)

---

## Self-review notes

- **Spec coverage:** §3 grammar → Tasks 2,4; §4.1 parser → Task 4; §4.2 planner/json_extract → Task 5; §4.3 exec/result types → Task 6; §5 IPC → Tasks 7-9; §6 frontend renderer → Task 11, widget → Task 12, wrapper → Task 10; §7 testing contracts → tasks' test steps + Task 12 (operator-smoke); §9 DoD → Tasks 13-15. All covered.
- **Type consistency:** `QueryResult`/`NoteRef`/`Row` (snake_case serde tags `list`/`table`/`count`) defined in Task 6, mapped in Task 7's `DataviewResult` (adds `error`), mirrored in TS in Task 10, consumed in Tasks 11-12. `SqlParam` defined in Task 5, consumed in Task 6. `parse`/`run` re-exported in Task 1's `lib.rs`.
- **Deferred (design §8), absent by construction:** OR/parens, contains, GROUP/FLATTEN, typed dates, formula columns, write-back.
- **Verify-against-real-API flags** left inline where a libSQL accessor name (`get_value`) or an `OpenVault::new` signature must be confirmed against the pinned versions rather than assumed.
