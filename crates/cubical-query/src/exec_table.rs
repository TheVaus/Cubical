use std::cmp::Ordering;

use cubical_table::{Cell, Table};

use crate::ast::{Command, Cond, Op, Query, SortDir, Value};
use crate::exec::{ListItem, QueryResult, Row};

fn ordering_matches(op: Op, ord: Ordering) -> bool {
    match op {
        Op::Eq => ord == Ordering::Equal,
        Op::Ne => ord != Ordering::Equal,
        Op::Lt => ord == Ordering::Less,
        Op::Le => ord != Ordering::Greater,
        Op::Gt => ord == Ordering::Greater,
        Op::Ge => ord != Ordering::Less,
    }
}

fn cell_matches(cell: &Cell, cond: &Cond) -> bool {
    if cell.is_empty() {
        return false;
    }
    match &cond.value {
        Value::Str(literal) => ordering_matches(cond.op, cell.text.as_str().cmp(literal.as_str())),
        Value::Num(literal) => match cell.num {
            Some(n) => n
                .partial_cmp(literal)
                .is_some_and(|ord| ordering_matches(cond.op, ord)),
            None => false,
        },
        Value::Bool(literal) => match cell.boolean {
            Some(b) => ordering_matches(cond.op, b.cmp(literal)),
            None => false,
        },
    }
}

fn row_matches(table: &Table, row: &[Cell], conds: &[Cond]) -> bool {
    conds
        .iter()
        .all(|cond| match table.column_index(&cond.key) {
            Some(idx) => row.get(idx).is_some_and(|cell| cell_matches(cell, cond)),
            None => false,
        })
}

fn sort_rank(cell: Option<&Cell>) -> u8 {
    match cell {
        None => 2,
        Some(c) if c.is_empty() => 2,
        Some(c) if c.num.is_some() => 0,
        Some(_) => 1,
    }
}

fn compare_present(a: &Cell, b: &Cell) -> Ordering {
    match (a.num, b.num) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        _ => a.text.cmp(&b.text),
    }
}

fn compare_for_sort(a: Option<&Cell>, b: Option<&Cell>, dir: SortDir) -> Ordering {
    let (rank_a, rank_b) = (sort_rank(a), sort_rank(b));
    if rank_a == 2 || rank_b == 2 {
        return rank_a.cmp(&rank_b);
    }
    let present = match (a, b) {
        (Some(x), Some(y)) => rank_a.cmp(&rank_b).then_with(|| compare_present(x, y)),
        _ => Ordering::Equal,
    };
    match dir {
        SortDir::Asc => present,
        SortDir::Desc => present.reverse(),
    }
}

fn cell_text_at(table: &Table, row: &[Cell], column: &str) -> String {
    table
        .column_index(column)
        .and_then(|idx| row.get(idx))
        .map_or_else(String::new, |cell| cell.text.clone())
}

#[must_use]
pub fn run(table: &Table, q: &Query) -> QueryResult {
    let mut selected: Vec<&Vec<Cell>> = table
        .rows
        .iter()
        .filter(|row| row_matches(table, row, &q.conds))
        .collect();

    if let Some(sort) = &q.sort {
        let key = table.column_index(&sort.key);
        selected.sort_by(|a, b| match key {
            Some(idx) => compare_for_sort(a.get(idx), b.get(idx), sort.dir),
            None => Ordering::Equal,
        });
    }

    match &q.command {
        Command::Count => QueryResult::Count {
            count: selected.len(),
        },
        Command::List => {
            let first = table.columns.first();
            QueryResult::List {
                items: selected
                    .iter()
                    .map(|row| ListItem {
                        text: first.map_or_else(String::new, |c| cell_text_at(table, row, c)),
                        note: None,
                    })
                    .collect(),
            }
        }
        Command::Table(cols) => QueryResult::Table {
            columns: cols.clone(),
            rows: selected
                .iter()
                .map(|row| Row {
                    note: None,
                    cells: cols
                        .iter()
                        .map(|col| cell_text_at(table, row, col))
                        .collect(),
                })
                .collect(),
            row_label: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn text(s: &str) -> Cell {
        Cell {
            text: s.to_string(),
            num: None,
            boolean: None,
        }
    }

    fn number(text: &str, n: f64) -> Cell {
        Cell {
            text: text.to_string(),
            num: Some(n),
            boolean: None,
        }
    }

    fn sales() -> Table {
        Table {
            columns: vec!["region".into(), "amount".into()],
            rows: vec![
                vec![text("EU"), number("120", 120.0)],
                vec![text("US"), number("80", 80.0)],
                vec![text("APAC"), number("300", 300.0)],
            ],
        }
    }

    fn run_source(table: &Table, source: &str) -> QueryResult {
        run(table, &parse(source).unwrap())
    }

    #[test]
    fn list_uses_the_first_column_and_links_nothing() {
        match run_source(&sales(), "LIST") {
            QueryResult::List { items } => {
                assert_eq!(
                    items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(),
                    vec!["EU", "US", "APAC"]
                );
                assert!(items.iter().all(|i| i.note.is_none()));
            }
            other => panic!("expected a list, got {other:?}"),
        }
    }

    #[test]
    fn a_data_table_has_no_row_label_and_no_note_column() {
        match run_source(&sales(), "TABLE region, amount") {
            QueryResult::Table {
                columns,
                rows,
                row_label,
            } => {
                assert_eq!(row_label, None);
                assert_eq!(columns, vec!["region".to_string(), "amount".to_string()]);
                assert!(rows.iter().all(|r| r.note.is_none()));
                assert_eq!(rows[0].cells, vec!["EU".to_string(), "120".to_string()]);
            }
            other => panic!("expected a table, got {other:?}"),
        }
    }

    #[test]
    fn where_and_sort_run_over_the_rows() {
        match run_source(&sales(), "LIST WHERE amount >= 100 SORT amount DESC") {
            QueryResult::List { items } => {
                assert_eq!(
                    items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(),
                    vec!["APAC", "EU"]
                );
            }
            other => panic!("expected a list, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_table_answers_every_command_without_erroring() {
        let empty = Table {
            columns: vec![],
            rows: vec![],
        };
        assert_eq!(run_source(&empty, "COUNT"), QueryResult::Count { count: 0 });
        match run_source(&empty, "LIST") {
            QueryResult::List { items } => assert!(items.is_empty()),
            other => panic!("expected a list, got {other:?}"),
        }
    }

    #[test]
    fn numbers_sort_before_text_and_empties_sort_last() {
        let mixed = Table {
            columns: vec!["k".into()],
            rows: vec![
                vec![text("beta")],
                vec![Cell {
                    text: String::new(),
                    num: None,
                    boolean: None,
                }],
                vec![number("7", 7.0)],
                vec![text("alpha")],
            ],
        };
        match run_source(&mixed, "LIST SORT k ASC") {
            QueryResult::List { items } => {
                assert_eq!(
                    items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(),
                    vec!["7", "alpha", "beta", ""]
                );
            }
            other => panic!("expected a list, got {other:?}"),
        }
    }
}
