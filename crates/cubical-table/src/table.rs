use std::mem::size_of;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cell {
    pub text: String,
    pub num: Option<f64>,
    pub boolean: Option<bool>,
}

impl Cell {
    pub fn from_text(raw: &str) -> Self {
        let mut cell = Cell {
            text: raw.to_string(),
            num: None,
            boolean: None,
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return cell;
        }
        if trimmed.eq_ignore_ascii_case("true") {
            cell.boolean = Some(true);
            return cell;
        }
        if trimmed.eq_ignore_ascii_case("false") {
            cell.boolean = Some(false);
            return cell;
        }
        if let Ok(n) = trimmed.parse::<f64>() {
            if n.is_finite() {
                cell.num = Some(n);
            }
        }
        cell
    }

    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty()
    }

    pub(crate) fn from_number(value: f64) -> Self {
        Cell {
            text: format_number(value),
            num: value.is_finite().then_some(value),
            boolean: None,
        }
    }

    pub(crate) fn from_int(value: i64) -> Self {
        Cell {
            text: value.to_string(),
            num: Some(value as f64),
            boolean: None,
        }
    }

    pub(crate) fn from_bool(value: bool) -> Self {
        Cell {
            text: value.to_string(),
            num: None,
            boolean: Some(value),
        }
    }

    pub(crate) fn verbatim(text: impl Into<String>) -> Self {
        Cell {
            text: text.into(),
            num: None,
            boolean: None,
        }
    }

    fn heap_bytes(&self) -> usize {
        self.text.capacity()
    }
}

pub(crate) fn format_number(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

impl Table {
    pub fn column_index(&self, name: &str) -> Option<usize> {
        self.columns.iter().position(|c| c == name)
    }

    pub fn get(&self, row: usize, column: &str) -> Option<&Cell> {
        let index = self.column_index(column)?;
        self.rows.get(row)?.get(index)
    }

    pub(crate) fn estimated_bytes(&self) -> usize {
        let columns: usize = self
            .columns
            .iter()
            .map(|c| size_of::<String>() + c.capacity())
            .sum();
        let rows: usize = self
            .rows
            .iter()
            .map(|row| {
                size_of::<Vec<Cell>>()
                    + row.len() * size_of::<Cell>()
                    + row.iter().map(Cell::heap_bytes).sum::<usize>()
            })
            .sum();
        size_of::<Table>() + columns + rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_zeroes_keep_their_text_and_gain_a_number() {
        let cell = Cell::from_text("007");
        assert_eq!(cell.text, "007");
        assert_eq!(cell.num, Some(7.0));
        assert_eq!(cell.boolean, None);
    }

    #[test]
    fn decimals_and_negatives_are_numeric() {
        assert_eq!(Cell::from_text("1.5").num, Some(1.5));
        assert_eq!(Cell::from_text("-3").num, Some(-3.0));
        assert_eq!(Cell::from_text("1e5").num, Some(100000.0));
        assert_eq!(Cell::from_text("1e5").text, "1e5");
    }

    #[test]
    fn near_numbers_stay_text_only() {
        for raw in ["1-2", "12abc", "1 2", "--3", "1,5", "0x10"] {
            let cell = Cell::from_text(raw);
            assert_eq!(cell.text, raw);
            assert_eq!(cell.num, None, "{raw} should not be numeric");
            assert_eq!(cell.boolean, None);
        }
    }

    #[test]
    fn infinities_and_nan_are_not_numbers() {
        for raw in ["inf", "-inf", "NaN", "infinity"] {
            assert_eq!(Cell::from_text(raw).num, None, "{raw}");
        }
    }

    #[test]
    fn booleans_are_case_insensitive_and_keep_their_spelling() {
        let t = Cell::from_text("true");
        assert_eq!(t.boolean, Some(true));
        assert_eq!(t.text, "true");
        let f = Cell::from_text("FALSE");
        assert_eq!(f.boolean, Some(false));
        assert_eq!(f.text, "FALSE");
        assert_eq!(Cell::from_text("True").boolean, Some(true));
        assert_eq!(Cell::from_text("False").num, None);
    }

    #[test]
    fn empty_and_blank_cells_are_empty() {
        let empty = Cell::from_text("");
        assert_eq!(empty, Cell::default());
        assert!(empty.is_empty());
        let blank = Cell::from_text("  ");
        assert!(blank.is_empty());
        assert_eq!(blank.text, "  ");
        assert_eq!(blank.num, None);
        assert!(!Cell::from_text("0").is_empty());
    }

    #[test]
    fn detection_trims_but_text_does_not() {
        let cell = Cell::from_text(" 42 ");
        assert_eq!(cell.text, " 42 ");
        assert_eq!(cell.num, Some(42.0));
        assert_eq!(Cell::from_text(" TRUE ").boolean, Some(true));
    }

    #[test]
    fn integral_numbers_render_without_a_trailing_decimal() {
        assert_eq!(Cell::from_number(42.0).text, "42");
        assert_eq!(Cell::from_number(-0.0).text, "0");
        assert_eq!(Cell::from_number(1.5).text, "1.5");
        assert_eq!(Cell::from_int(7).text, "7");
        assert_eq!(Cell::from_int(7).num, Some(7.0));
    }

    #[test]
    fn column_index_returns_the_first_duplicate() {
        let table = Table {
            columns: vec!["a".into(), "b".into(), "a".into()],
            rows: vec![vec![
                Cell::from_text("1"),
                Cell::from_text("2"),
                Cell::from_text("3"),
            ]],
        };
        assert_eq!(table.column_index("a"), Some(0));
        assert_eq!(table.column_index("b"), Some(1));
        assert_eq!(table.column_index("c"), None);
        assert_eq!(table.get(0, "a").map(|c| c.text.as_str()), Some("1"));
        assert_eq!(table.get(1, "a"), None);
        assert_eq!(table.get(0, "zzz"), None);
    }

    #[test]
    fn estimated_bytes_grows_with_content() {
        let small = Table {
            columns: vec!["a".into()],
            rows: vec![vec![Cell::from_text("x")]],
        };
        let big = Table {
            columns: vec!["a".into()],
            rows: (0..100)
                .map(|_| vec![Cell::from_text("xxxxxxxx")])
                .collect(),
        };
        assert!(small.estimated_bytes() < big.estimated_bytes());
        assert!(Table::default().estimated_bytes() > 0);
    }
}
