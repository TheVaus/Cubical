use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use calamine::{open_workbook, Data, ExcelDateTime, Range, Reader, Xlsx, XlsxError};

use crate::error::TableError;
use crate::table::{format_number, Cell, Table};

pub(crate) fn decode(path: &Path, sheet: Option<&str>) -> Result<Table, TableError> {
    let mut workbook: Xlsx<BufReader<File>> = open_workbook(path).map_err(as_error)?;
    let names = workbook.sheet_names();

    let name = match sheet {
        Some(requested) => match names.iter().find(|n| n.as_str() == requested) {
            Some(found) => found.clone(),
            None => {
                return Err(TableError::UnknownSheet {
                    requested: requested.to_string(),
                    available: names,
                })
            }
        },
        None => match names.first() {
            Some(first) => first.clone(),
            None => return Ok(Table::default()),
        },
    };

    let range = workbook.worksheet_range(&name).map_err(as_error)?;
    Ok(from_range(&range))
}

fn as_error(err: XlsxError) -> TableError {
    match err {
        XlsxError::Io(io) => TableError::Io(io),
        other => TableError::Decode(other.to_string()),
    }
}

fn from_range(range: &Range<Data>) -> Table {
    let grid: Vec<&[Data]> = range.rows().collect();
    let mut height = 0;
    let mut width = 0;
    for (r, row) in grid.iter().enumerate() {
        for (c, data) in row.iter().enumerate() {
            if !is_blank(data) {
                height = r + 1;
                width = width.max(c + 1);
            }
        }
    }
    if height == 0 || width == 0 {
        return Table::default();
    }

    let header = grid[0];
    let columns = (0..width)
        .map(|c| header.get(c).map(cell).unwrap_or_default().text)
        .collect();
    let rows = grid[1..height]
        .iter()
        .map(|row| {
            (0..width)
                .map(|c| row.get(c).map(cell).unwrap_or_default())
                .collect()
        })
        .collect();
    Table { columns, rows }
}

fn is_blank(data: &Data) -> bool {
    match data {
        Data::Empty => true,
        Data::String(s) => s.trim().is_empty(),
        _ => false,
    }
}

fn cell(data: &Data) -> Cell {
    match data {
        Data::Empty => Cell::default(),
        Data::String(s) => Cell::from_text(s),
        Data::Float(f) => Cell::from_number(*f),
        Data::Int(i) => Cell::from_int(*i),
        Data::Bool(b) => Cell::from_bool(*b),
        Data::DateTime(dt) => Cell::verbatim(render_datetime(dt)),
        Data::DateTimeIso(s) => Cell::verbatim(s),
        Data::DurationIso(s) => Cell::verbatim(s),
        Data::Error(e) => Cell::verbatim(e.to_string()),
    }
}

fn render_datetime(dt: &ExcelDateTime) -> String {
    if dt.is_duration() {
        return format_number(dt.as_f64());
    }
    let (y, mo, d, h, mi, s, ms) = dt.to_ymd_hms_milli();
    if h == 0 && mi == 0 && s == 0 && ms == 0 {
        format!("{y:04}-{mo:02}-{d:02}")
    } else {
        format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{CellErrorType, ExcelDateTimeType};
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    fn load(name: &str, sheet: Option<&str>) -> Table {
        match decode(&fixture(name), sheet) {
            Ok(table) => table,
            Err(err) => panic!("decode failed: {err}"),
        }
    }

    fn texts(row: &[Cell]) -> Vec<&str> {
        row.iter().map(|c| c.text.as_str()).collect()
    }

    #[test]
    fn no_sheet_selects_the_first_one() {
        let table = load("workbook.xlsx", None);
        assert_eq!(table.columns, vec!["name", "qty", "ok", "due", "code"]);
    }

    #[test]
    fn a_sheet_can_be_selected_by_name() {
        let table = load("workbook.xlsx", Some("Q2"));
        assert_eq!(table.columns, vec!["city", "population"]);
        assert_eq!(texts(&table.rows[0]), vec!["Oslo", "709037"]);
    }

    #[test]
    fn an_unknown_sheet_lists_what_the_workbook_has() {
        let err = match decode(&fixture("workbook.xlsx"), Some("Q5")) {
            Err(err) => err,
            Ok(_) => panic!("expected an unknown-sheet error"),
        };
        assert_eq!(
            err.to_string(),
            "unknown sheet \"Q5\"; this workbook has: Q1, Q2, Q3"
        );
    }

    #[test]
    fn a_missing_workbook_is_an_io_error() {
        let err = match decode(&fixture("nope.xlsx"), None) {
            Err(err) => err,
            Ok(_) => panic!("expected an io error"),
        };
        assert!(matches!(err, TableError::Io(_)), "{err:?}");
    }

    #[test]
    fn numbers_booleans_dates_and_text_all_decode() {
        let table = load("workbook.xlsx", None);
        let first = &table.rows[0];
        assert_eq!(first[0].text, "Alpha");
        assert_eq!(first[0].num, None);
        assert_eq!(first[1].text, "2");
        assert_eq!(first[1].num, Some(2.0));
        assert_eq!(first[2].text, "true");
        assert_eq!(first[2].boolean, Some(true));
        assert_eq!(first[3].text, "2024-01-15");
        assert_eq!(first[3].num, None);
        assert_eq!(first[4].text, "007");
        assert_eq!(first[4].num, Some(7.0));

        let second = &table.rows[1];
        assert_eq!(second[1].text, "1.5");
        assert_eq!(second[1].num, Some(1.5));
        assert_eq!(second[2].boolean, Some(false));
        assert_eq!(second[3].text, "2024-03-02T13:45:30");
        assert!(second[4].is_empty());
    }

    #[test]
    fn a_formula_cell_decodes_to_its_cached_value() {
        let table = load("workbook.xlsx", None);
        let total = &table.rows[2];
        assert_eq!(total[0].text, "Total");
        assert_eq!(total[1].text, "3.5");
        assert_eq!(total[1].num, Some(3.5));
    }

    #[test]
    fn trailing_empty_rows_and_columns_are_trimmed() {
        let mut workbook: Xlsx<BufReader<File>> = match open_workbook(fixture("workbook.xlsx")) {
            Ok(workbook) => workbook,
            Err(err) => panic!("open failed: {err}"),
        };
        let range = match workbook.worksheet_range("Q1") {
            Ok(range) => range,
            Err(err) => panic!("range failed: {err}"),
        };
        assert_eq!((range.height(), range.width()), (5, 6));

        let table = load("workbook.xlsx", None);
        assert_eq!(table.columns.len(), 5);
        assert_eq!(table.rows.len(), 3);
        for row in &table.rows {
            assert_eq!(row.len(), 5);
        }
    }

    #[test]
    fn an_empty_sheet_is_an_empty_table_not_an_error() {
        let table = load("workbook.xlsx", Some("Q3"));
        assert!(table.columns.is_empty());
        assert!(table.rows.is_empty());
    }

    #[test]
    fn every_data_variant_keeps_its_display_text() {
        assert_eq!(cell(&Data::Empty), Cell::default());
        assert_eq!(cell(&Data::Int(42)).text, "42");
        assert_eq!(cell(&Data::Float(42.0)).text, "42");
        assert_eq!(cell(&Data::Float(1.5)).num, Some(1.5));
        assert_eq!(cell(&Data::String("007".into())).num, Some(7.0));
        assert_eq!(cell(&Data::String(" true ".into())).boolean, Some(true));
        assert_eq!(cell(&Data::Bool(false)).text, "false");

        let iso = cell(&Data::DateTimeIso("2024-01-15T00:00:00".into()));
        assert_eq!(iso.text, "2024-01-15T00:00:00");
        assert_eq!(iso.num, None);

        let duration = cell(&Data::DurationIso("PT1H30M".into()));
        assert_eq!(duration.text, "PT1H30M");

        let error = cell(&Data::Error(CellErrorType::Div0));
        assert_eq!(error.text, "#DIV/0!");
        assert_eq!(error.num, None);
    }

    #[test]
    fn a_datetime_with_a_time_component_keeps_it() {
        let date = ExcelDateTime::new(45306.0, ExcelDateTimeType::DateTime, false);
        assert_eq!(render_datetime(&date), "2024-01-15");
        let stamp = ExcelDateTime::new(45306.5, ExcelDateTimeType::DateTime, false);
        assert_eq!(render_datetime(&stamp), "2024-01-15T12:00:00");
        let duration = ExcelDateTime::new(1.5, ExcelDateTimeType::TimeDelta, false);
        assert_eq!(render_datetime(&duration), "1.5");
    }
}
