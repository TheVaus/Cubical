use cubical_core::{block_id_at_line_end, is_valid_block_id};
use serde::Deserialize;

const FIXTURES_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/block-ids.json");

#[derive(Debug, Deserialize)]
struct IdCase {
    name: String,
    id: String,
    valid: bool,
}

#[derive(Debug, Deserialize)]
struct LineCase {
    name: String,
    line: String,
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Fixtures {
    ids: Vec<IdCase>,
    lines: Vec<LineCase>,
}

fn fixtures() -> Fixtures {
    let raw = std::fs::read_to_string(FIXTURES_PATH).expect("read block-id fixtures");
    serde_json::from_str(&raw).expect("parse block-id fixtures JSON")
}

#[test]
fn fixture_ids_match_the_owning_grammar() {
    let f = fixtures();
    let mut diffs = Vec::new();
    for case in &f.ids {
        let actual = is_valid_block_id(&case.id);
        if actual != case.valid {
            diffs.push(format!(
                "`{}` ({:?}): fixture says valid={}, is_valid_block_id says {}",
                case.name, case.id, case.valid, actual
            ));
        }
    }
    assert!(diffs.is_empty(), "{}", diffs.join("\n"));
}

#[test]
fn fixture_lines_match_the_owning_extractor() {
    let f = fixtures();
    let mut diffs = Vec::new();
    for case in &f.lines {
        let actual = block_id_at_line_end(&case.line);
        if actual.as_deref() != case.id.as_deref() {
            diffs.push(format!(
                "`{}` ({:?}): fixture says {:?}, block_id_at_line_end says {:?}",
                case.name, case.line, case.id, actual
            ));
        }
    }
    assert!(diffs.is_empty(), "{}", diffs.join("\n"));
}
