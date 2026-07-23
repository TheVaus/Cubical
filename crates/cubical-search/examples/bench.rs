use std::path::PathBuf;
use std::time::Instant;

use cubical_search::query::{run_search, FieldScope, SearchQuery, SortMode};
use cubical_search::SearchIndex;

const SINGLE_TERMS: &[&str] = &[
    "the",
    "search",
    "note",
    "vault",
    "index",
    "link",
    "tag",
    "block",
    "embed",
    "tantivy",
    "frontmatter",
    "markdown",
    "rust",
    "tokio",
    "result",
    "error",
    "scan",
    "watcher",
    "refresh",
    "commit",
    "writer",
    "reader",
    "schema",
    "field",
    "query",
    "parser",
    "snippet",
    "match",
    "title",
    "body",
    "code",
    "heading",
    "fuzzy",
    "score",
    "limit",
    "offset",
    "open",
    "close",
    "create",
    "delete",
    "modify",
    "rename",
    "pending",
    "rewrite",
    "flush",
    "interval",
    "cache",
    "memo",
    "task",
    "project",
    "daily",
    "weekly",
    "monthly",
    "yearly",
    "agenda",
    "kanban",
    "todo",
    "done",
    "review",
    "draft",
    "final",
    "archive",
    "inbox",
    "outbox",
    "sent",
    "received",
    "reply",
    "forward",
    "thread",
    "subject",
    "from",
    "client",
    "server",
    "request",
    "response",
    "header",
    "payload",
    "auth",
    "token",
    "session",
    "cookie",
    "session",
    "user",
    "admin",
    "config",
    "settings",
    "options",
    "prefs",
    "theme",
    "color",
    "font",
    "size",
    "layout",
    "grid",
    "list",
    "table",
    "row",
    "column",
    "cell",
    "value",
    "key",
    "pair",
];

const TWO_TERMS: &[(&str, &str)] = &[
    ("search", "index"),
    ("rust", "code"),
    ("tag", "page"),
    ("wiki", "link"),
    ("block", "reference"),
    ("embed", "content"),
    ("pending", "rewrite"),
    ("frontmatter", "yaml"),
    ("vault", "open"),
    ("scan", "complete"),
    ("watcher", "event"),
    ("note", "title"),
    ("daily", "note"),
    ("project", "task"),
    ("review", "draft"),
    ("client", "server"),
    ("user", "admin"),
    ("config", "settings"),
    ("theme", "color"),
    ("font", "size"),
    ("grid", "layout"),
    ("list", "table"),
    ("row", "column"),
    ("key", "value"),
    ("auth", "token"),
    ("session", "cookie"),
    ("request", "response"),
    ("header", "payload"),
    ("api", "endpoint"),
    ("error", "handling"),
    ("result", "option"),
    ("trait", "impl"),
    ("struct", "field"),
    ("enum", "variant"),
    ("async", "await"),
    ("future", "tokio"),
    ("mutex", "lock"),
    ("arc", "rc"),
    ("vec", "iter"),
    ("map", "filter"),
    ("collect", "fold"),
    ("read", "write"),
    ("file", "path"),
    ("dir", "entry"),
    ("temp", "dir"),
    ("test", "assert"),
    ("mock", "fixture"),
    ("inbox", "outbox"),
    ("sent", "reply"),
    ("thread", "subject"),
];

fn field_scoped_queries() -> Vec<(FieldScope, &'static str)> {
    let mut v = Vec::with_capacity(30);
    for t in [
        "search", "note", "project", "tag", "review", "daily", "draft", "task", "embed", "link",
    ] {
        v.push((FieldScope::HeadingsOnly, t));
    }
    for t in [
        "tantivy",
        "vault",
        "index",
        "note",
        "search",
        "block",
        "frontmatter",
        "tag",
        "review",
        "project",
    ] {
        v.push((FieldScope::BodyOnly, t));
    }
    for t in [
        "fn", "struct", "impl", "let", "pub", "async", "use", "mod", "trait", "self",
    ] {
        v.push((FieldScope::CodeOnly, t));
    }
    v
}

const PHRASES: &[&str] = &[
    "\"search index\"",
    "\"wiki link\"",
    "\"block reference\"",
    "\"pending rewrites\"",
    "\"daily note\"",
    "\"project task\"",
    "\"review draft\"",
    "\"client server\"",
    "\"user admin\"",
    "\"config settings\"",
    "\"file path\"",
    "\"temp dir\"",
    "\"test assert\"",
    "\"vault open\"",
    "\"scan complete\"",
    "\"watcher event\"",
    "\"frontmatter yaml\"",
    "\"rust code\"",
    "\"async await\"",
    "\"error handling\"",
];

fn percentile(sorted_ms: &[f64], pct: f64) -> f64 {
    if sorted_ms.is_empty() {
        return 0.0;
    }
    let idx = ((sorted_ms.len() as f64 - 1.0) * pct).round() as usize;
    sorted_ms[idx.min(sorted_ms.len() - 1)]
}

fn main() {
    let Ok(vault_dir) = std::env::var("CUBICAL_SEARCH_BENCH_VAULT").map(PathBuf::from) else {
        println!(
            "set CUBICAL_SEARCH_BENCH_VAULT=<absolute-vault-path> to run this benchmark — skipping"
        );
        return;
    };
    let search_dir = vault_dir.join(".cubical/search");

    if !search_dir.exists() {
        println!(
            "vault not found at {} — skipping (run cargo tauri dev against the vault to build the index first)",
            search_dir.display()
        );
        return;
    }

    println!("opening index at {}", search_dir.display());
    let idx = match SearchIndex::open(&search_dir) {
        Ok(idx) => idx,
        Err(e) => {
            println!("failed to open index: {e:#} — skipping");
            return;
        }
    };

    let doc_count = idx.doc_count().unwrap_or(0);
    let seg_count = idx.segment_count();
    println!("index opened: {doc_count} docs across {seg_count} segments");
    println!("running 200-query benchmark mix…");

    let mut samples_ms: Vec<f64> = Vec::with_capacity(200);

    for term in SINGLE_TERMS.iter().take(100) {
        let q = SearchQuery {
            text: (*term).into(),
            limit: 50,
            offset: 0,
            fields: FieldScope::Default,
            fuzzy: false,
            sort: SortMode::Relevance,
        };
        let start = Instant::now();
        let _ = run_search(&idx, &q);
        samples_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    for (a, b) in TWO_TERMS.iter().take(50) {
        let q = SearchQuery {
            text: format!("{a} {b}"),
            limit: 50,
            offset: 0,
            fields: FieldScope::Default,
            fuzzy: false,
            sort: SortMode::Relevance,
        };
        let start = Instant::now();
        let _ = run_search(&idx, &q);
        samples_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    for (scope, text) in field_scoped_queries().into_iter().take(30) {
        let q = SearchQuery {
            text: text.into(),
            limit: 50,
            offset: 0,
            fields: scope,
            fuzzy: false,
            sort: SortMode::Relevance,
        };
        let start = Instant::now();
        let _ = run_search(&idx, &q);
        samples_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    for phrase in PHRASES.iter().take(20) {
        let q = SearchQuery {
            text: (*phrase).into(),
            limit: 50,
            offset: 0,
            fields: FieldScope::Default,
            fuzzy: false,
            sort: SortMode::Relevance,
        };
        let start = Instant::now();
        let _ = run_search(&idx, &q);
        samples_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    let mut sorted = samples_ms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let p50 = percentile(&sorted, 0.50);
    let p99 = percentile(&sorted, 0.99);
    let min = sorted.first().copied().unwrap_or(0.0);
    let max = sorted.last().copied().unwrap_or(0.0);
    let mean = if sorted.is_empty() {
        0.0
    } else {
        sorted.iter().sum::<f64>() / sorted.len() as f64
    };

    println!("--- L4-A query benchmark ({} samples) ---", sorted.len());
    println!("p50 : {p50:>7.2} ms");
    println!("p99 : {p99:>7.2} ms");
    println!("mean: {mean:>7.2} ms");
    println!("min : {min:>7.2} ms");
    println!("max : {max:>7.2} ms");
    println!("budget (logged, not gated): p50 < 15 ms, p99 < 80 ms");
}
