use crate::types::{Frontmatter, Span};
use serde_json::Value as JsonValue;
use serde_yaml_ng::Value as YamlValue;

#[must_use]
pub fn split_frontmatter(source: &str) -> (Option<&str>, &str) {
    let (yaml, body, _) = split_with_offset(source);
    (yaml, body)
}

pub(crate) fn split_with_offset(source: &str) -> (Option<&str>, &str, usize) {
    let after_opener = if let Some(rest) = source.strip_prefix("---\n") {
        rest
    } else if let Some(rest) = source.strip_prefix("---\r\n") {
        rest
    } else {
        return (None, source, 0);
    };

    let opener_len = source.len() - after_opener.len();
    let mut cursor = opener_len;
    let bytes = source.as_bytes();
    let mut line_start = cursor;

    while cursor <= bytes.len() {
        let line_end = bytes[cursor..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| cursor + i)
            .unwrap_or(bytes.len());

        let mut line = &source[line_start..line_end];
        if let Some(stripped) = line.strip_suffix('\r') {
            line = stripped;
        }

        if line == "---" {
            let yaml = &source[opener_len..line_start];
            let body_start = if line_end < bytes.len() {
                line_end + 1
            } else {
                bytes.len()
            };
            let body = &source[body_start..];
            return (Some(yaml), body, body_start);
        }

        if line_end == bytes.len() {
            return (None, source, 0);
        }
        cursor = line_end + 1;
        line_start = cursor;
    }

    (None, source, 0)
}

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
            other => yaml_value_to_string_key(&other),
        };
        entries.push((key, yaml_value_to_json(v)));
    }

    Ok(Some(Frontmatter {
        entries,
        span: Span::new(0, 0),
    }))
}

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
        other => serde_yaml_ng::to_string(other).unwrap_or_default(),
    }
}

#[must_use]
pub fn parse_frontmatter(source: &str) -> Option<Frontmatter> {
    let (yaml_opt, _body, body_offset) = split_with_offset(source);
    let yaml_str = yaml_opt?;
    parse_with_span(yaml_str, body_offset).ok().flatten()
}

impl Frontmatter {
    #[must_use]
    pub fn get_string(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .and_then(|(_, v)| v.as_str())
    }

    #[must_use]
    pub fn get_string_list(&self, key: &str) -> Vec<&str> {
        let Some((_, value)) = self.entries.iter().find(|(k, _)| k == key) else {
            return Vec::new();
        };
        let JsonValue::Array(items) = value else {
            return Vec::new();
        };
        items.iter().filter_map(|v| v.as_str()).collect()
    }

    #[must_use]
    pub fn flattened_scalars(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for (key, value) in &self.entries {
            flatten_value(key, value, &mut out);
        }
        out
    }
}

fn flatten_value(prefix: &str, value: &JsonValue, out: &mut Vec<(String, String)>) {
    match value {
        JsonValue::Null => {}
        JsonValue::Bool(b) => out.push((prefix.to_string(), b.to_string())),
        JsonValue::Number(n) => out.push((prefix.to_string(), n.to_string())),
        JsonValue::String(s) => out.push((prefix.to_string(), s.clone())),
        JsonValue::Array(items) => {
            for item in items {
                flatten_value(prefix, item, out);
            }
        }
        JsonValue::Object(map) => {
            for (k, v) in map {
                let nested = format!("{prefix}.{k}");
                flatten_value(&nested, v, out);
            }
        }
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

    #[test]
    fn parse_frontmatter_returns_some_for_valid_block() {
        let src = "---\ntitle: Hello\n---\n\nbody\n";
        let fm = parse_frontmatter(src).expect("some");
        assert_eq!(fm.get_string("title"), Some("Hello"));
    }

    #[test]
    fn parse_frontmatter_returns_none_for_missing_or_malformed() {
        assert!(parse_frontmatter("# just body\n").is_none());
        assert!(parse_frontmatter("---\ntitle: : :\n  - bad\n---\n").is_none());
    }

    #[test]
    fn get_string_returns_some_for_scalar_none_otherwise() {
        let fm = parse_yaml("title: Hello\ncount: 3\nready: true\n")
            .expect("parse")
            .expect("some");
        assert_eq!(fm.get_string("title"), Some("Hello"));
        assert_eq!(fm.get_string("count"), None);
        assert_eq!(fm.get_string("ready"), None);
        assert_eq!(fm.get_string("missing"), None);
    }

    #[test]
    fn get_string_list_returns_vec_for_string_list_empty_otherwise() {
        let fm = parse_yaml("tags: [a, b, c]\nmixed: [a, 1, true]\nscalar: x\n")
            .expect("parse")
            .expect("some");
        assert_eq!(fm.get_string_list("tags"), vec!["a", "b", "c"]);
        assert_eq!(fm.get_string_list("mixed"), vec!["a"]);
        assert!(fm.get_string_list("scalar").is_empty());
        assert!(fm.get_string_list("missing").is_empty());
    }

    #[test]
    fn flattened_scalars_walks_scalars_lists_and_nested_maps() {
        let yaml =
            "title: T\ntags: [a, b]\nready: true\ncount: 3\nmeta:\n  author: jane\n  pub: false\n";
        let fm = parse_yaml(yaml).expect("parse").expect("some");
        let flat = fm.flattened_scalars();
        assert_eq!(
            flat,
            vec![
                ("title".to_string(), "T".to_string()),
                ("tags".to_string(), "a".to_string()),
                ("tags".to_string(), "b".to_string()),
                ("ready".to_string(), "true".to_string()),
                ("count".to_string(), "3".to_string()),
                ("meta.author".to_string(), "jane".to_string()),
                ("meta.pub".to_string(), "false".to_string()),
            ]
        );
    }
}
