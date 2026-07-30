use crate::protocol::Outcome;
use std::io::Write;

pub fn render_to(outcome: &Outcome, json: bool, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    match outcome {
        Outcome::Files(paths) => {
            if json {
                let _ = writeln!(
                    out,
                    "{}",
                    serde_json::to_string_pretty(paths).unwrap_or_default()
                );
            } else {
                for p in paths {
                    let _ = writeln!(out, "{p}");
                }
            }
            0
        }
        Outcome::Resolved { target, path } => match path {
            Some(p) => {
                if json {
                    let _ = writeln!(out, "{}", serde_json::json!({ "target_path": p }));
                } else {
                    let _ = writeln!(out, "{p}");
                }
                0
            }
            None => {
                let _ = writeln!(err, "unresolved: {target}");
                1
            }
        },
        Outcome::Backlinks(sources) => {
            if json {
                let _ = writeln!(
                    out,
                    "{}",
                    serde_json::to_string_pretty(sources).unwrap_or_default()
                );
            } else {
                for s in sources {
                    let _ = writeln!(out, "{s}");
                }
            }
            0
        }
        Outcome::Created(path) => {
            if json {
                let _ = writeln!(out, "{}", serde_json::json!({ "path": path }));
            } else {
                let _ = writeln!(out, "{path}");
            }
            0
        }
        Outcome::Wrote(path) => {
            if json {
                let _ = writeln!(out, "{}", serde_json::json!({ "path": path }));
            } else {
                let _ = writeln!(out, "wrote {path}");
            }
            0
        }
        Outcome::Renamed { to, pending_count } => {
            if json {
                let _ = writeln!(
                    out,
                    "{}",
                    serde_json::json!({ "path": to, "pending_count": pending_count })
                );
            } else {
                let _ = writeln!(out, "renamed -> {to}");
            }
            0
        }
        Outcome::Trashed(path) => {
            if !json {
                let _ = writeln!(out, "trashed {path}");
            }
            0
        }
        Outcome::SettingSet(key) => {
            if !json {
                let _ = writeln!(out, "set {key}");
            }
            0
        }
        Outcome::SettingGet { key, value } => match value {
            Some(v) => {
                let _ = writeln!(out, "{}", serde_json::to_string(v).unwrap_or_default());
                0
            }
            None => {
                let _ = writeln!(err, "unset: {key}");
                1
            }
        },
        Outcome::UndoRename {
            op_id,
            removed,
            pending_count,
        } => {
            if json {
                let _ = writeln!(
                    out,
                    "{}",
                    serde_json::json!({ "op_id": op_id, "removed": removed, "pending_count": pending_count })
                );
            } else {
                let _ = writeln!(out, "undid rename op {op_id} (removed {removed} rows)");
            }
            0
        }
    }
}

pub fn render(outcome: &Outcome, json: bool) -> i32 {
    let mut out = std::io::stdout();
    let mut err = std::io::stderr();
    render_to(outcome, json, &mut out, &mut err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Outcome;

    #[test]
    fn resolved_none_exits_one() {
        let code = render(
            &Outcome::Resolved {
                target: "X".into(),
                path: None,
            },
            false,
        );
        assert_eq!(code, 1);
    }

    #[test]
    fn resolved_some_exits_zero() {
        let code = render(
            &Outcome::Resolved {
                target: "X".into(),
                path: Some("X.md".into()),
            },
            false,
        );
        assert_eq!(code, 0);
    }

    #[test]
    fn setting_get_unset_exits_one() {
        let code = render(
            &Outcome::SettingGet {
                key: "k".into(),
                value: None,
            },
            false,
        );
        assert_eq!(code, 1);
    }

    #[test]
    fn created_exits_zero() {
        assert_eq!(render(&Outcome::Created("A.md".into()), false), 0);
        assert_eq!(render(&Outcome::Created("A.md".into()), true), 0);
    }

    fn run(outcome: &Outcome, json: bool) -> (String, String, i32) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = render_to(outcome, json, &mut out, &mut err);
        (
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
            code,
        )
    }

    #[test]
    fn files_plain_lists_one_per_line() {
        let (out, err, code) = run(&Outcome::Files(vec!["a.md".into(), "b.md".into()]), false);
        assert_eq!(out, "a.md\nb.md\n");
        assert_eq!(err, "");
        assert_eq!(code, 0);
    }

    #[test]
    fn resolved_none_writes_to_err_code_one() {
        let (out, err, code) = run(
            &Outcome::Resolved {
                target: "X".into(),
                path: None,
            },
            false,
        );
        assert_eq!(out, "");
        assert_eq!(err, "unresolved: X\n");
        assert_eq!(code, 1);
    }

    #[test]
    fn created_json_emits_object() {
        let (out, _err, code) = run(&Outcome::Created("A.md".into()), true);
        assert_eq!(out.trim(), r#"{"path":"A.md"}"#);
        assert_eq!(code, 0);
    }
}
