use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use cubical_search::query::{run_search, FieldScope, SearchQuery, SortMode};
use cubical_search::{IndexDoc, SearchIndex};

type BenchError = Box<dyn std::error::Error>;

const FIXTURE_MARKER: &str = ".prefix-bench-fixture";
const VOCAB: usize = 60_000;
const SYLLABLES: &[&str] = &[
    "re", "co", "st", "ma", "de", "in", "pro", "con", "ex", "ra", "ti", "on", "al", "er", "le",
    "mo", "pa", "si", "tu", "ve", "no", "ca", "li", "or",
];

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn skewed(&mut self, n: usize) -> usize {
        let u = (self.next() % 1_000_000) as f64 / 1_000_000.0;
        ((u * u * u) * n as f64) as usize
    }
}

fn vocabulary() -> Vec<String> {
    let mut rng = Rng(0x5EED_CAFE);
    (0..VOCAB)
        .map(|_| {
            let parts = 2 + rng.below(3);
            (0..parts)
                .map(|_| SYLLABLES[rng.below(SYLLABLES.len())])
                .collect::<String>()
        })
        .collect()
}

fn words(rng: &mut Rng, vocab: &[String], n: usize) -> String {
    (0..n)
        .map(|_| vocab[rng.skewed(vocab.len())].as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn ensure_fixture_dir(dir: &Path) -> Result<(), BenchError> {
    fs::create_dir_all(dir)?;
    if dir.join(FIXTURE_MARKER).exists() {
        return Ok(());
    }
    let occupied = fs::read_dir(dir)?.next().is_some();
    if occupied {
        return Err(format!(
            "refusing to operate on {}: no {FIXTURE_MARKER} and the directory is not empty. \
             prefix_bench deletes its index directory before every run; point it at a scratch directory.",
            dir.display()
        )
        .into());
    }
    fs::write(dir.join(FIXTURE_MARKER), b"")?;
    Ok(())
}

fn build_index(dir: &Path, notes: usize, vocab: &[String]) -> Result<SearchIndex, BenchError> {
    let index_dir = dir.join("index");
    if index_dir.exists() {
        fs::remove_dir_all(&index_dir)?;
    }
    let idx = SearchIndex::open(&index_dir)?;
    for i in 0..notes {
        let mut rng = Rng(0xC0BE_1CA1_u64 ^ (i as u64).wrapping_mul(0x0100_0000_01B3));
        idx.upsert(&IndexDoc {
            path: format!("notes/{i:05}.md"),
            title: words(&mut rng, vocab, 4),
            headings: words(&mut rng, vocab, 8),
            body: words(&mut rng, vocab, 150),
            code: words(&mut rng, vocab, 20),
            tags: vec![
                vocab[rng.skewed(vocab.len())].clone(),
                vocab[rng.skewed(vocab.len())].clone(),
            ],
            frontmatter: words(&mut rng, vocab, 6),
            mtime_secs: 1_717_000_000 + i as i64,
            size_bytes: 2048,
        })?;
    }
    idx.commit()?;
    Ok(idx)
}

fn median(mut v: Vec<f64>) -> (f64, f64, f64) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n == 0 {
        return (0.0, 0.0, 0.0);
    }
    let mid = if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    };
    (v[0], mid, v[n - 1])
}

fn main() -> Result<(), BenchError> {
    let args: Vec<String> = std::env::args().collect();
    let Some(dir) = args.get(1).map(PathBuf::from) else {
        println!("usage: prefix_bench <scratch-dir> [notes] [runs]");
        return Ok(());
    };
    let notes: usize = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(10_000);
    let runs: usize = args.get(3).and_then(|a| a.parse().ok()).unwrap_or(5).max(1);

    ensure_fixture_dir(&dir)?;
    let vocab = vocabulary();
    let built = Instant::now();
    let idx = build_index(&dir, notes, &vocab)?;
    println!(
        "indexed {} notes over {} segments in {:.2}s",
        idx.doc_count()?,
        idx.segment_count(),
        built.elapsed().as_secs_f64()
    );

    let lead = vocab[0].clone();
    let queries = [
        "r".to_string(),
        "re".to_string(),
        "co".to_string(),
        format!("{lead} r"),
        format!("{lead} re"),
        format!("{lead} co"),
    ];

    let mut per_query: Vec<Vec<f64>> = vec![Vec::with_capacity(runs); queries.len()];
    let mut totals = Vec::with_capacity(runs);
    for _ in 0..runs {
        let mut total = 0.0;
        for (i, text) in queries.iter().enumerate() {
            let q = SearchQuery {
                text: text.clone(),
                limit: 50,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            };
            let start = Instant::now();
            run_search(&idx, &q)?;
            let secs = start.elapsed().as_secs_f64();
            per_query[i].push(secs);
            total += secs;
        }
        totals.push(total);
    }

    for (text, samples) in queries.iter().zip(per_query) {
        let (_, mid, _) = median(samples);
        println!("  {text:<24} median {:>8.2} ms", mid * 1000.0);
    }
    let (lo, mid, hi) = median(totals);
    println!(
        "--- prefix mix, {notes} notes, {} queries, {runs} runs ---",
        queries.len()
    );
    println!("prefix    : min {lo:.4} s / median {mid:.4} s / max {hi:.4} s");
    Ok(())
}
