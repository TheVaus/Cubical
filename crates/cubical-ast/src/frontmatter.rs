//! YAML frontmatter detection and parsing.
//!
//! Frontmatter must sit at byte offset 0: the opening `---` is the
//! very first line of the file, with no leading whitespace, and a
//! matching closing `---` on its own line. Anything looser — leading
//! blank lines, leading spaces before `---`, frontmatter inside a
//! code fence — is *not* frontmatter; the whole source is treated as
//! body. This is intentionally strict: external tools (Obsidian,
//! Logseq, Hugo, Jekyll) all converge on the same shape, and being
//! lenient here would silently reinterpret edge-case `.md` files.

use crate::types::{Frontmatter, Span};
use serde_yaml_ng::Value as YamlValue;

/// Split a source string into `(yaml_str_opt, body_str)`.
///
/// Public helper for callers that want to re-render the body without
/// re-tokenizing the whole file. Returns `(None, source)` if no
/// frontmatter is present.
#[must_use]
pub fn split_frontmatter(source: &str) -> (Option<&str>, &str) {
    let (yaml, body, _) = split_with_offset(source);
    (yaml, body)
}

/// Inner helper that also returns the byte offset where the body
/// begins. Used by [`crate::parse`] so block-level spans line up with
/// the original source.
pub(crate) fn split_with_offset(source: &str) -> (Option<&str>, &str, usize) {
    // Strict opener: the source must begin with exactly `---` followed
    // by a newline (LF or CRLF). No BOM tolerance, no leading
    // whitespace tolerance — both would conflict with external tools.
    let after_opener = if let Some(rest) = source.strip_prefix("---\n") {
        rest
    } else if let Some(rest) = source.strip_prefix("---\r\n") {
        rest
    } else {
        return (None, source, 0);
    };

    // Walk lines. The closing `---` must be on its own line (just
    // `---` with optional trailing CR), and must not be inside a
    // fenced code block within the YAML region — but YAML doesn't
    // syntactically have fenced code blocks, so a literal `---` on
    // its own line in the YAML region is unambiguously the closer.
    //
    // Track line offsets manually rather than reaching for
    // `str::lines()`, since we need to know where the line ended in
    // the original source so we can return correct slices.
    let opener_len = source.len() - after_opener.len();
    let mut cursor = opener_len;
    let bytes = source.as_bytes();
    let mut line_start = cursor;

    while cursor <= bytes.len() {
        // Find end of this line.
        let line_end = bytes[cursor..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| cursor + i)
            .unwrap_or(bytes.len());

        // Slice without the trailing CR (if any) so `---\r` matches.
        let mut line = &source[line_start..line_end];
        if let Some(stripped) = line.strip_suffix('\r') {
            line = stripped;
        }

        if line == "---" {
            // YAML body is everything between the opener and this line.
            let yaml = &source[opener_len..line_start];
            // Body begins after the closing line's terminating `\n`.
            let body_start = if line_end < bytes.len() {
                line_end + 1
            } else {
                bytes.len()
            };
            let body = &source[body_start..];
            return (Some(yaml), body, body_start);
        }

        if line_end == bytes.len() {
            // Hit EOF without finding a closer.
            return (None, source, 0);
        }
        cursor = line_end + 1;
        line_start = cursor;
    }

    (None, source, 0)
}

/// Parse a YAML frontmatter region into a [`Frontmatter`].
///
/// Returns `Ok(None)` when the YAML parses to a non-mapping value
/// (e.g. a bare scalar or list at the top level), since Cubical only
/// recognizes mapping-shaped frontmatter. Returns `Err(_)` only for
/// hard syntax errors; the caller logs and degrades to "no
/// frontmatter."
pub(crate) fn parse_yaml(yaml_str: &str) -> Result<Option<Frontmatter>, serde_yaml_ng::Error> {
    let value: YamlValue = match yaml_str.trim().is_empty() {
        true => return Ok(None),
        false => serde_yaml_ng::from_str(yaml_str)?,
    };
    let YamlValue::Mapping(mapping) = value else {
        return Ok(None);
    };

    let mut entries: Vec<(String, serde_json::Value)> = Vec::with_capacity(mapping.len());
    for (k, v) in mapping {
        let key = match k {
            YamlValue::String(s) => s,
            // Non-string keys (bool, number) get stringified for
            // libSQL storage; this matches Obsidian/Hugo behavior.
            other => yaml_value_to_string_key(&other),
        };
        entries.push((key, yaml_value_to_json(v)));
    }

    // The span is filled in by the caller, which knows the byte
    // offsets of the surrounding `---` lines. We default to the
    // YAML-text length so this function is self-contained for
    // unit testing; `parse()` overwrites it with the absolute span.
    Ok(Some(Frontmatter {
        entries,
        span: Span::new(0, 0),
    }))
}

/// Compute the absolute span of a frontmatter block within the
/// original source — `[0, body_offset)` — and return a [`Frontmatter`]
/// stamped with it. `parse_yaml` does not know the absolute offsets;
/// this helper is the seam where they are applied.
pub(crate) fn parse_with_span(
    yaml_str: &str,
    body_offset: usize,
) -> Result<Option<Frontmatter>, serde_yaml_ng::Error> {
    let parsed = parse_yaml(yaml_str)?;
    Ok(parsed.map(|mut fm| {
        fm.span = Span::new(0, body_offset);
        fm
    }))
}

fn yaml_value_to_json(v: YamlValue) -> serde_json::Value {
    match v {
        YamlValue::Null => serde_json::Value::Null,
        YamlValue::Bool(b) => serde_json::Value::Bool(b),
        YamlValue::Number(n) => {
            // serde_yaml_ng's Number can be int or float. Try the
            // narrower types first so JSON storage stays exact for
            // integer-shaped frontmatter (e.g. `version: 3`).
            if let Some(i) = n.as_i64() {
                serde_json::Value::from(i)
            } else if let Some(u) = n.as_u64() {
                serde_json::Value::from(u)
            } else if let Some(f) = n.as_f64() {
                serde_json::Number::from_f64(f)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            } else {
                serde_json::Value::Null
            }
        }
        YamlValue::String(s) => serde_json::Value::String(s),
        YamlValue::Sequence(seq) => {
            serde_json::Value::Array(seq.into_iter().map(yaml_value_to_json).collect())
        }
        YamlValue::Mapping(m) => {
            let mut obj = serde_json::Map::with_capacity(m.len());
            for (k, v) in m {
                let key = match k {
                    YamlValue::String(s) => s,
                    other => yaml_value_to_string_key(&other),
                };
                obj.insert(key, yaml_value_to_json(v));
            }
            serde_json::Value::Object(obj)
        }
        YamlValue::Tagged(t) => yaml_value_to_json(t.value),
    }
}

fn yaml_value_to_string_key(v: &YamlValue) -> String {
    match v {
        YamlValue::Null => "null".to_string(),
        YamlValue::Bool(b) => b.to_string(),
        YamlValue::Number(n) => n.to_string(),
        YamlValue::String(s) => s.clone(),
        // Sequences and mappings as keys are pathological — fall back
        // to YAML serialization. Loss of fidelity here is acceptable.
        other => serde_yaml_ng::to_string(other).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_returns_none_for_empty_source() {
        let (yaml, body) = split_frontmatter("");
        assert!(yaml.is_none());
        assert_eq!(body, "");
    }

    #[test]
    fn split_returns_none_for_no_frontmatter() {
        let src = "# Heading\nbody\n";
        let (yaml, body) = split_frontmatter(src);
        assert!(yaml.is_none());
        assert_eq!(body, src);
    }

    #[test]
    fn split_extracts_simple_frontmatter() {
        let src = "---\ntitle: Hello\n---\n\n# Body\n";
        let (yaml, body) = split_frontmatter(src);
        assert_eq!(yaml.unwrap(), "title: Hello\n");
        assert_eq!(body, "\n# Body\n");
    }

    #[test]
    fn split_handles_crlf_line_endings() {
        let src = "---\r\ntitle: Hello\r\n---\r\nBody\r\n";
        let (yaml, body) = split_frontmatter(src);
        assert_eq!(yaml.unwrap(), "title: Hello\r\n");
        assert_eq!(body, "Body\r\n");
    }

    #[test]
    fn split_rejects_leading_whitespace_before_opener() {
        // A space, tab, or blank line before `---` disqualifies it.
        let cases = [
            " ---\ntitle: x\n---\nbody\n",
            "\t---\ntitle: x\n---\nbody\n",
            "\n---\ntitle: x\n---\nbody\n",
        ];
        for src in cases {
            let (yaml, body) = split_frontmatter(src);
            assert!(yaml.is_none(), "src: {src:?}");
            assert_eq!(body, src);
        }
    }

    #[test]
    fn split_returns_none_when_no_closing_marker() {
        let src = "---\ntitle: Hello\n# Body\n";
        let (yaml, body) = split_frontmatter(src);
        assert!(yaml.is_none(), "missing closer must not match");
        assert_eq!(body, src);
    }

    #[test]
    fn split_does_not_treat_dashes_inside_a_code_fence_as_closer() {
        // `---` inside a fenced code block in the *body* is fine — the
        // YAML region above closes properly. Verify the closer is the
        // first standalone `---`, and the body is left intact.
        let src = "---\ntitle: Hello\n---\n\n```\n---\n```\n";
        let (yaml, body) = split_frontmatter(src);
        assert_eq!(yaml.unwrap(), "title: Hello\n");
        assert_eq!(body, "\n```\n---\n```\n");
    }

    #[test]
    fn split_returns_offset_lining_up_with_body() {
        let src = "---\ntitle: x\n---\nbody\n";
        let (_, body, off) = split_with_offset(src);
        assert_eq!(off, src.len() - body.len());
        assert_eq!(&src[off..], body);
    }

    #[test]
    fn parse_yaml_handles_scalars_lists_and_nested_maps() {
        let yaml =
            "title: Hello\ncount: 3\nready: true\ntags: [a, b]\nmeta:\n  author: dani\n  pub: false\n";
        let fm = parse_yaml(yaml).expect("parse").expect("some");
        let map: std::collections::HashMap<_, _> = fm.entries.into_iter().collect();
        assert_eq!(map["title"], serde_json::json!("Hello"));
        assert_eq!(map["count"], serde_json::json!(3));
        assert_eq!(map["ready"], serde_json::json!(true));
        assert_eq!(map["tags"], serde_json::json!(["a", "b"]));
        assert_eq!(
            map["meta"],
            serde_json::json!({ "author": "dani", "pub": false })
        );
    }

    #[test]
    fn parse_yaml_returns_none_for_non_mapping_top_level() {
        let yaml = "- a\n- b\n";
        let fm = parse_yaml(yaml).expect("parse");
        assert!(fm.is_none(), "list-shaped frontmatter is not recognized");
    }

    #[test]
    fn parse_yaml_returns_err_on_malformed() {
        let yaml = "title: : :\n  - bad\n";
        let res = parse_yaml(yaml);
        assert!(res.is_err(), "expected hard parse error");
    }

    #[test]
    fn parse_yaml_returns_none_for_empty_block() {
        let fm = parse_yaml("").expect("parse");
        assert!(fm.is_none());
    }
}
