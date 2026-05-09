//! Cross-language AST parity harness — Rust side.
//!
//! Owns the source-of-truth assertion that
//! `cubical_ast::parse(input)` serialized as JSON equals each fixture's
//! `expected` field. The same fixture file is consumed by the
//! TypeScript side (`ui/src/ast/parity.test.ts`) so a single ground
//! truth keeps the editor's Lezer-backed normalizer and the indexer's
//! pulldown-cmark normalizer in lockstep.
//!
//! ## Updating fixtures
//!
//! When you intentionally change the AST shape, regenerate the
//! `expected` fields in place by setting an env var:
//!
//! ```sh
//! CUBICAL_UPDATE_PARITY_FIXTURES=1 cargo test -p cubical-ast --test parity_fixtures
//! ```
//!
//! Then re-run the TS side (`cd ui && npm test`) to confirm the
//! normalizer agrees with the new shape. If it doesn't, fix the TS
//! normalizer — never edit the fixtures by hand.

use cubical_ast::parse;
use serde::{Deserialize, Serialize};

const FIXTURES_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/parity.json");

#[derive(Debug, Deserialize, Serialize)]
struct Fixture {
    name: String,
    input: String,
    expected: serde_json::Value,
}

#[test]
fn parity_fixtures_match_rust_parser() {
    let raw = std::fs::read_to_string(FIXTURES_PATH).expect("read parity fixtures");
    let mut fixtures: Vec<Fixture> =
        serde_json::from_str(&raw).expect("parse parity fixtures JSON");
    let update = std::env::var("CUBICAL_UPDATE_PARITY_FIXTURES").is_ok();
    let mut diffs: Vec<String> = Vec::new();

    for f in fixtures.iter_mut() {
        let actual = serde_json::to_value(parse(&f.input))
            .expect("Document must round-trip through serde_json");
        if update {
            f.expected = actual;
        } else if f.expected != actual {
            diffs.push(format!(
                "fixture `{}` drifted:\n--- expected ---\n{}\n--- actual ---\n{}\n",
                f.name,
                serde_json::to_string_pretty(&f.expected).unwrap(),
                serde_json::to_string_pretty(&actual).unwrap(),
            ));
        }
    }

    if update {
        let mut pretty = serde_json::to_string_pretty(&fixtures).unwrap();
        pretty.push('\n');
        std::fs::write(FIXTURES_PATH, pretty).expect("write parity fixtures");
        return;
    }

    assert!(
        diffs.is_empty(),
        "{} parity fixture(s) drifted from cubical_ast::parse:\n\n{}\n\
         Re-run with CUBICAL_UPDATE_PARITY_FIXTURES=1 to refresh after \
         intentionally changing the AST shape.",
        diffs.len(),
        diffs.join("\n"),
    );
}
