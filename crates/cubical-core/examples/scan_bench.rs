use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use cubical_core::vault::{scan, ScanProgress, Vault};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const VOCAB: &[&str] = &[
    "vault",
    "note",
    "index",
    "search",
    "link",
    "block",
    "embed",
    "markdown",
    "frontmatter",
    "parser",
    "resolver",
    "watcher",
    "rename",
    "convergence",
    "portable",
    "local",
    "plain",
    "file",
    "source",
    "truth",
    "derived",
    "state",
    "rebuild",
    "scan",
    "commit",
    "segment",
    "schema",
    "field",
    "query",
    "snippet",
    "ranking",
    "relevance",
    "cursor",
    "editor",
    "preview",
    "render",
    "layout",
    "panel",
    "sidebar",
    "palette",
    "shortcut",
    "binding",
    "command",
    "dispatch",
    "channel",
    "event",
    "stream",
    "buffer",
    "journal",
    "tombstone",
    "inode",
    "hash",
    "digest",
    "path",
    "folder",
    "tree",
    "graph",
    "backlink",
    "outline",
    "heading",
    "paragraph",
    "sentence",
    "clause",
    "phrase",
    "token",
    "stem",
    "lexicon",
    "corpus",
    "document",
    "record",
    "entry",
    "property",
    "value",
    "scalar",
    "list",
    "mapping",
    "registry",
    "plugin",
    "sandbox",
    "capability",
    "gateway",
    "audit",
    "integrity",
    "recovery",
    "candidate",
    "confirmation",
    "migration",
    "version",
    "release",
    "branch",
    "merge",
    "review",
    "spec",
    "plan",
    "handoff",
    "session",
    "protocol",
    "cadence",
    "increment",
    "primitive",
    "component",
    "token",
    "theme",
    "palette",
    "contrast",
    "spacing",
    "rhythm",
    "typography",
    "hierarchy",
    "affordance",
    "friction",
    "latency",
    "throughput",
    "budget",
    "ceiling",
    "baseline",
    "measurement",
    "sample",
    "median",
    "outlier",
    "variance",
    "cache",
    "warm",
    "cold",
    "flush",
    "batch",
    "transaction",
    "rollback",
    "durable",
    "atomic",
    "idempotent",
    "deterministic",
    "reproducible",
    "fixture",
    "harness",
    "assertion",
    "coverage",
    "regression",
    "flake",
    "gate",
    "pipeline",
    "artifact",
    "binary",
    "release",
    "profile",
    "symbol",
    "trace",
    "span",
    "metric",
    "counter",
    "histogram",
    "threshold",
];

const TAGS: &[&str] = &[
    "project/cubical",
    "area/search",
    "area/index",
    "area/ui",
    "status/draft",
    "status/active",
    "topic/rust",
    "topic/markdown",
    "topic/perf",
    "weekly",
    "reference",
    "inbox",
];

const STATUSES: &[&str] = &["draft", "active", "review", "done", "archived"];

const BUCKETS: usize = 20;

type Prepared = (
    String,
    Vec<(String, String)>,
    Vec<cubical_index::LinkRow>,
    Vec<cubical_index::TagRow>,
);

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + self.below(hi - lo + 1)
    }

    fn word(&mut self) -> &'static str {
        VOCAB[self.below(VOCAB.len())]
    }
}

fn rel_path(i: usize) -> String {
    format!("notes/{:02}/note-{:05}.md", i % BUCKETS, i)
}

fn sentence(rng: &mut Rng, words: usize) -> String {
    let mut s = String::with_capacity(words * 8);
    for w in 0..words {
        if w > 0 {
            s.push(' ');
        }
        let word = rng.word();
        if w == 0 {
            let mut c = word.chars();
            if let Some(first) = c.next() {
                s.extend(first.to_uppercase());
                s.push_str(c.as_str());
            }
        } else {
            s.push_str(word);
        }
    }
    s.push('.');
    s
}

fn note_body(rng: &mut Rng, i: usize, total: usize) -> String {
    let mut out = String::with_capacity(12_000);

    let title = format!("{} {}", rng.word(), rng.word());
    out.push_str("---\n");
    out.push_str(&format!("title: {title} {i}\n"));
    out.push_str(&format!(
        "created: 2026-{:02}-{:02}\n",
        rng.range(1, 12),
        rng.range(1, 28)
    ));
    out.push_str(&format!(
        "status: {}\n",
        STATUSES[rng.below(STATUSES.len())]
    ));
    out.push_str(&format!("author: person-{:02}\n", rng.below(25)));
    out.push_str(&format!("weight: {}\n", rng.range(1, 100)));
    let tag_count = rng.range(2, 4);
    let mut tags: Vec<&str> = Vec::with_capacity(tag_count);
    for _ in 0..tag_count {
        let t = TAGS[rng.below(TAGS.len())];
        if !tags.contains(&t) {
            tags.push(t);
        }
    }
    out.push_str(&format!("tags: [{}]\n", tags.join(", ")));
    out.push_str("---\n\n");

    out.push_str(&format!("# {title} {i}\n\n"));

    let paragraphs = rng.range(10, 18);
    let links_wanted = rng.range(4, 9);
    let mut links_placed = 0usize;

    for p in 0..paragraphs {
        if p > 0 && p % 4 == 0 {
            out.push_str(&format!("## {} {}\n\n", rng.word(), rng.word()));
        }

        let sentences = rng.range(4, 7);
        for s in 0..sentences {
            let n = rng.range(9, 18);
            out.push_str(&sentence(rng, n));
            out.push(' ');
            if links_placed < links_wanted && s == 1 && p % 2 == 0 {
                let target = rng.below(total);
                if rng.below(3) == 0 {
                    out.push_str(&format!(
                        "See [[note-{:05}|{}]] for context. ",
                        target,
                        rng.word()
                    ));
                } else {
                    out.push_str(&format!("See [[note-{target:05}]] for context. "));
                }
                links_placed += 1;
            }
        }
        if p % 3 == 1 {
            out.push_str(&format!(
                "Filed under #{} and #{}. ",
                TAGS[rng.below(TAGS.len())],
                rng.word()
            ));
        }
        out.push_str("\n\n");

        if p == 3 {
            for k in 0..3 {
                out.push_str(if k == 0 { "- " } else { "\n- " });
                let n = rng.range(5, 10);
                out.push_str(&sentence(rng, n));
            }
            out.push_str("\n\n");
        }

        if p == 6 {
            out.push_str("```rust\n");
            out.push_str(&format!(
                "pub fn {}_{}(input: &str) -> Option<{}> {{\n",
                rng.word(),
                i,
                rng.word()
            ));
            out.push_str("    let parsed = input.trim().parse().ok()?;\n");
            out.push_str(&format!(
                "    let {} = parsed + {};\n",
                rng.word(),
                rng.range(1, 999)
            ));
            out.push_str("    Some(parsed)\n}\n");
            out.push_str("```\n\n");
        }
    }

    out.push_str(&format!(
        "Related: [[note-{:05}]], [[note-{:05}]].\n",
        rng.below(total),
        rng.below(total)
    ));

    out
}

type BenchError = Box<dyn std::error::Error>;

const FIXTURE_MARKER: &str = ".scan-bench-fixture";

fn ensure_fixture_dir(dir: &Path) {
    if dir.join(FIXTURE_MARKER).exists() {
        return;
    }
    let occupied = fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if occupied {
        eprintln!(
            "refusing to operate on {}: no {FIXTURE_MARKER} and the directory is not empty.\n\
             scan_bench deletes .cubical/ before every run, which would destroy config.toml,\n\
             themes/ and the rename journal of a real vault. Point it at a scratch directory.",
            dir.display()
        );
        std::process::exit(1);
    }
}

fn generate(dir: &Path, total: usize) -> std::io::Result<u64> {
    for b in 0..BUCKETS {
        fs::create_dir_all(dir.join(format!("notes/{b:02}")))?;
    }
    fs::write(dir.join(FIXTURE_MARKER), b"")?;
    let mut bytes = 0u64;
    for i in 0..total {
        let mut rng = Rng::new(0xC0BE_1CA1_u64 ^ (i as u64).wrapping_mul(0x0100_0000_01B3));
        let body = note_body(&mut rng, i, total);
        bytes += body.len() as u64;
        fs::write(dir.join(rel_path(i)), body)?;
    }
    Ok(bytes)
}

async fn cold_run(dir: &Path) -> Result<(f64, f64, u32, u64), BenchError> {
    let cubical = dir.join(".cubical");
    if cubical.exists() {
        fs::remove_dir_all(&cubical)?;
    }

    let t_open = Instant::now();
    let vault = Vault::open(dir).await?;
    let open_secs = t_open.elapsed().as_secs_f64();

    let t_scan = Instant::now();
    let (tx, mut rx) = mpsc::channel::<ScanProgress>(64);
    let handle = tokio::spawn(scan(vault.clone(), CancellationToken::new(), tx));
    let pump = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let processed = handle.await??;
    let _ = pump.await;
    let scan_secs = t_scan.elapsed().as_secs_f64();

    let docs = vault.search().doc_count().unwrap_or(0);
    Ok((open_secs, scan_secs, processed, docs))
}

fn stats(mut v: Vec<f64>) -> (f64, f64, f64) {
    if v.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    v.sort_by(f64::total_cmp);
    let n = v.len();
    let median = if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    };
    (v[0], median, v[n - 1])
}

async fn phase_breakdown(dir: &Path, total: usize) -> Result<(), BenchError> {
    use cubical_ast::parse;
    use cubical_core::vault::{extract_links, extract_tags};

    let mut sources: Vec<(String, String)> = Vec::with_capacity(total);
    let t = Instant::now();
    for i in 0..total {
        let rel = rel_path(i);
        let s = fs::read_to_string(dir.join(&rel))?;
        sources.push((rel, s));
    }
    let read_secs = t.elapsed().as_secs_f64();

    let t = Instant::now();
    let mut sink = 0usize;
    for (_, s) in &sources {
        sink += cubical_core::sha256_bytes_hex(s.as_bytes()).len();
    }
    let hash_secs = t.elapsed().as_secs_f64();

    let t = Instant::now();
    for (_, s) in &sources {
        let doc = parse(s);
        sink += extract_links(&doc).len();
        let doc2 = parse(s);
        sink += extract_tags(&doc2).len();
        let doc3 = parse(s);
        sink += doc3.blocks.len();
        sink += cubical_core::vault::blocks::extract_block_ids(s).len();
    }
    let parse_secs = t.elapsed().as_secs_f64();

    let t = Instant::now();
    let mut projected = Vec::with_capacity(total);
    for (rel, s) in &sources {
        projected.push(cubical_search::doc::project(rel, s, 0, s.len() as u64));
    }
    let project_secs = t.elapsed().as_secs_f64();

    let resolver = cubical_core::vault::links::PathResolver::build(
        sources.iter().map(|(r, _)| r.clone()).collect(),
    );
    let mut prepared: Vec<Prepared> = Vec::with_capacity(total);
    for (rel, s) in &sources {
        let doc = parse(s);
        let fm = doc
            .frontmatter
            .as_ref()
            .map(|f| {
                f.entries
                    .iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            serde_json::to_string(v).unwrap_or_else(|_| "null".into()),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let links = extract_links(&doc)
            .into_iter()
            .map(|e| {
                let target_path = resolver.resolve(&e.target_raw);
                let (anchor_kind, anchor_value) = match e.anchor {
                    Some(cubical_ast::Anchor::Heading { value }) => {
                        (Some("heading".to_string()), Some(value))
                    }
                    Some(cubical_ast::Anchor::Block { value }) => {
                        (Some("block".to_string()), Some(value))
                    }
                    None => (None, None),
                };
                cubical_index::LinkRow {
                    target_raw: e.target_raw,
                    target_path,
                    anchor_kind,
                    anchor_value,
                    display_text: e.display,
                    is_embed: e.is_embed,
                    position: e.position,
                }
            })
            .collect();
        let tags = extract_tags(&doc)
            .into_iter()
            .map(|t| cubical_index::TagRow {
                tag_path: t.tag_path,
                source: t.source,
            })
            .collect();
        prepared.push((rel.clone(), fm, links, tags));
    }

    let db = dir.join(".bench-index.db");
    let _ = fs::remove_file(&db);
    let t = Instant::now();
    let index = cubical_index::open_index(&db).await?;
    let conn = index.connection();
    let mut tx = conn.transaction().await?;
    let mut batch = 0u32;
    for (rel, fm, links, tags) in &prepared {
        conn.execute(
            "INSERT INTO files (path, type_id, size_bytes, mtime_unix, content_hash, inode, last_seen, created_at, updated_at)
             VALUES (?1, 'markdown', 0, 0, 'x', NULL, 0, 0, 0)
             ON CONFLICT(path) DO UPDATE SET updated_at = 0",
            libsql::params![rel.as_str()],
        )
        .await?;
        conn.execute(
            "DELETE FROM frontmatter WHERE file_path = ?1",
            libsql::params![rel.as_str()],
        )
        .await?;
        for (k, v) in fm {
            conn.execute(
                "INSERT OR REPLACE INTO frontmatter (file_path, key, value) VALUES (?1, ?2, ?3)",
                libsql::params![rel.as_str(), k.as_str(), v.as_str()],
            )
            .await?;
        }
        cubical_index::replace_tags_for_file(&index, rel, tags).await?;
        cubical_index::replace_blocks_for_file(&index, rel, &[]).await?;
        cubical_index::replace_links_for_file(&index, rel, links).await?;
        batch += 1;
        if batch >= 500 {
            tx.commit().await?;
            tx = conn.transaction().await?;
            batch = 0;
        }
    }
    tx.commit().await?;
    let libsql_secs = t.elapsed().as_secs_f64();
    drop(index);
    let _ = fs::remove_file(&db);
    let _ = fs::remove_file(dir.join(".bench-index.db-wal"));
    let _ = fs::remove_file(dir.join(".bench-index.db-shm"));

    let tmp = dir.join(".bench-tantivy");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp)?;
    let t = Instant::now();
    let idx = cubical_search::SearchIndex::open(&tmp)?;
    for d in &projected {
        idx.upsert(d)?;
    }
    idx.commit()?;
    let tantivy_secs = t.elapsed().as_secs_f64();
    let _ = fs::remove_dir_all(&tmp);

    println!("--- phase breakdown (isolated, {total} notes, single sample) ---");
    println!("read sources          : {read_secs:>7.2} s");
    println!("content hash (sha256) : {hash_secs:>7.2} s");
    println!("ast parse x3 + blocks : {parse_secs:>7.2} s");
    println!("search doc::project   : {project_secs:>7.2} s  (a 4th full parse)");
    println!("tantivy add + commit  : {tantivy_secs:>7.2} s  (excludes project)");
    println!(
        "libsql writes         : {libsql_secs:>7.2} s  (files/fm/tags/blocks/links, 500-batch)"
    );
    println!(
        "subtotal              : {:>7.2} s",
        read_secs + hash_secs + parse_secs + project_secs + tantivy_secs + libsql_secs
    );
    println!("(sink {sink})");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), BenchError> {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: scan_bench <fixture-dir> <note-count> [runs] [--phases]";
    if args.len() < 3 {
        println!("{usage}");
        return Ok(());
    }
    let dir = PathBuf::from(&args[1]);
    let total: usize = args[2]
        .parse()
        .map_err(|_| format!("note-count must be a positive integer, got {:?}", args[2]))?;
    if total == 0 {
        return Err("note-count must be at least 1".into());
    }
    let runs: usize = match args.get(3).filter(|a| !a.starts_with("--")) {
        Some(a) => a
            .parse()
            .map_err(|_| format!("runs must be a positive integer, got {a:?}"))?,
        None => 3,
    };
    let phases = args.iter().any(|a| a == "--phases");

    ensure_fixture_dir(&dir);

    if !dir.join(rel_path(total - 1)).exists() {
        fs::create_dir_all(&dir)?;
        let t = Instant::now();
        let bytes = generate(&dir, total)?;
        println!(
            "generated {total} notes ({:.1} MiB) in {:.2} s at {}",
            bytes as f64 / (1024.0 * 1024.0),
            t.elapsed().as_secs_f64(),
            dir.display()
        );
    } else {
        println!("reusing fixture at {}", dir.display());
    }

    if phases {
        phase_breakdown(&dir, total).await?;
        return Ok(());
    }

    let mut totals = Vec::with_capacity(runs);
    let mut scans = Vec::with_capacity(runs);
    for r in 1..=runs {
        let (open_secs, scan_secs, processed, docs) = cold_run(&dir).await?;
        println!(
            "run {r}: open {open_secs:.3} s + scan {scan_secs:.3} s = {:.3} s  ({processed} files, {docs} search docs)",
            open_secs + scan_secs
        );
        totals.push(open_secs + scan_secs);
        scans.push(scan_secs);
    }

    let (tmin, tmed, tmax) = stats(totals);
    let (smin, smed, smax) = stats(scans);
    println!("--- cold open+scan, {total} notes, {runs} runs ---");
    println!("scan only : min {smin:.2} s / median {smed:.2} s / max {smax:.2} s");
    println!("open+scan : min {tmin:.2} s / median {tmed:.2} s / max {tmax:.2} s");
    Ok(())
}
