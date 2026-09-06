use crate::ast::{Command, Op, Query, SortDir, Source, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum SqlParam {
    Text(String),
    Real(f64),
    Int(i64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub sql: String,
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

fn normalized(column: &str) -> String {
    format!(
        "CASE json_type({column},'$') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' \
         ELSE json_extract({column},'$') END"
    )
}

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

#[must_use]
pub fn plan(q: &Query) -> Plan {
    let mut params: Vec<SqlParam> = Vec::new();

    let select = match &q.command {
        Command::Count => "SELECT COUNT(*)".to_string(),
        Command::List => "SELECT files.path".to_string(),
        Command::Table(cols) => {
            let mut parts = vec!["files.path".to_string()];
            for col in cols {
                parts.push(format!(
                    "(SELECT {} FROM frontmatter \
                     WHERE file_path = files.path AND key = ?)",
                    normalized("value")
                ));
                params.push(SqlParam::Text(col.clone()));
            }
            format!("SELECT {}", parts.join(", "))
        }
    };

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
        Some(Source::Path(f)) => {
            wheres.push("files.path LIKE ? ESCAPE '\\'".to_string());
            let trimmed = f.trim_end_matches('/');
            params.push(SqlParam::Text(format!("{}/%", escape_like(trimmed))));
        }
        None => {}
    }
    for cond in &q.conds {
        let norm = normalized("f.value");
        let predicate = match &cond.value {
            Value::Str(_) => format!("CAST({norm} AS TEXT) {} ?", op_sql(cond.op)),
            Value::Num(_) => format!(
                "typeof({norm}) IN ('integer','real') AND {norm} {} ?",
                op_sql(cond.op)
            ),
            Value::Bool(_) => format!(
                "json_type(f.value,'$') IN ('true','false') \
                 AND json_extract(f.value,'$') {} ?",
                op_sql(cond.op)
            ),
        };
        wheres.push(format!(
            "EXISTS (SELECT 1 FROM frontmatter f WHERE f.file_path = files.path \
             AND f.key = ? AND {predicate})"
        ));
        params.push(SqlParam::Text(cond.key.clone()));
        params.push(value_param(&cond.value));
    }

    let mut sql = format!("{select} FROM files");
    if !wheres.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&wheres.join(" AND "));
    }

    if !matches!(q.command, Command::Count) {
        match &q.sort {
            Some(sort) => {
                let dir = match sort.dir {
                    SortDir::Asc => "ASC",
                    SortDir::Desc => "DESC",
                };
                let norm = normalized("value");
                sql.push_str(&format!(
                    " ORDER BY (SELECT {norm} FROM frontmatter \
                     WHERE file_path = files.path AND key = ?) IS NULL, \
                     (SELECT {norm} FROM frontmatter \
                     WHERE file_path = files.path AND key = ?) "
                ));
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
    fn plans_from_path_trims_trailing_slash() {
        let q = Query {
            command: Command::List,
            source: Some(Source::Path("areas/health/".into())),
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
        assert!(p.sql.contains("typeof(CASE json_type(f.value,'$')"));
        assert!(p.sql.contains("IN ('integer','real')"));
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
            .starts_with("SELECT files.path, (SELECT CASE json_type(value,'$')"));
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
