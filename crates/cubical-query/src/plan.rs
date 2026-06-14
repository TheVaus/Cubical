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

fn op_sql(op: Op) -> &'static str {
    match op {
        Op::Eq => "=",
        Op::Ne => "!=",
        Op::Lt => "<",
        Op::Le => "<=",
        Op::Gt => ">",
        Op::Ge => ">=",
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
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Compile a query into SQL + parameters.
#[must_use]
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
                     WHERE file_path = files.path AND key = ?)"
                        .to_string(),
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
                 WHERE LOWER(tag_path) = ? OR LOWER(tag_path) LIKE ? ESCAPE '\\')"
                    .to_string(),
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
                let dir = match sort.dir {
                    SortDir::Asc => "ASC",
                    SortDir::Desc => "DESC",
                };
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{Cond, Sort};

    #[test]
    fn plans_bare_list() {
        let q = Query {
            command: Command::List,
            source: None,
            conds: vec![],
            sort: None,
        };
        let p = plan(&q);
        assert_eq!(p.sql, "SELECT files.path FROM files ORDER BY files.path");
        assert!(p.params.is_empty());
    }

    #[test]
    fn plans_count_has_no_order_by() {
        let q = Query {
            command: Command::Count,
            source: None,
            conds: vec![],
            sort: None,
        };
        assert_eq!(plan(&q).sql, "SELECT COUNT(*) FROM files");
    }

    #[test]
    fn plans_from_tag() {
        let q = Query {
            command: Command::List,
            source: Some(Source::Tag("Project".into())),
            conds: vec![],
            sort: None,
        };
        let p = plan(&q);
        assert!(p.sql.contains("files.path IN (SELECT file_path FROM tags"));
        assert_eq!(
            p.params,
            vec![
                SqlParam::Text("project".into()),
                SqlParam::Text("project/%".into()),
            ]
        );
    }

    #[test]
    fn plans_from_folder_trims_trailing_slash() {
        let q = Query {
            command: Command::List,
            source: Some(Source::Folder("areas/health/".into())),
            conds: vec![],
            sort: None,
        };
        let p = plan(&q);
        assert!(p.sql.contains("files.path LIKE ? ESCAPE"));
        assert_eq!(p.params, vec![SqlParam::Text("areas/health/%".into())]);
    }

    #[test]
    fn plans_where_uses_json_extract_and_typed_params() {
        let q = Query {
            command: Command::List,
            source: None,
            conds: vec![
                Cond {
                    key: "priority".into(),
                    op: Op::Ge,
                    value: Value::Num(2.0),
                },
                Cond {
                    key: "done".into(),
                    op: Op::Eq,
                    value: Value::Bool(true),
                },
            ],
            sort: None,
        };
        let p = plan(&q);
        assert!(p.sql.contains("json_extract(f.value,'$') >= ?"));
        assert!(p.sql.contains(" AND EXISTS"));
        assert_eq!(
            p.params,
            vec![
                SqlParam::Text("priority".into()),
                SqlParam::Real(2.0),
                SqlParam::Text("done".into()),
                SqlParam::Int(1),
            ]
        );
    }

    #[test]
    fn plans_table_columns_as_scalar_subqueries() {
        let q = Query {
            command: Command::Table(vec!["status".into()]),
            source: None,
            conds: vec![],
            sort: None,
        };
        let p = plan(&q);
        assert!(p
            .sql
            .starts_with("SELECT files.path, (SELECT json_extract(value,'$')"));
        assert_eq!(p.params, vec![SqlParam::Text("status".into())]);
    }

    #[test]
    fn plans_sort_orders_missing_keys_last() {
        let q = Query {
            command: Command::List,
            source: None,
            conds: vec![],
            sort: Some(Sort {
                key: "due_date".into(),
                dir: SortDir::Desc,
            }),
        };
        let p = plan(&q);
        assert!(p.sql.contains("IS NULL, "));
        assert!(p.sql.contains(") DESC, files.path"));
        assert_eq!(
            p.params,
            vec![
                SqlParam::Text("due_date".into()),
                SqlParam::Text("due_date".into()),
            ]
        );
    }
}
