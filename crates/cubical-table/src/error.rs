use thiserror::Error;

#[derive(Debug, Error)]
pub enum TableError {
    #[error("could not read the table file: {0}")]
    Io(#[from] std::io::Error),

    #[error("unsupported table format \"{extension}\"; expected .csv, .tsv, .xlsx or .xlsm")]
    UnsupportedFormat { extension: String },

    #[error("unknown sheet \"{requested}\"; {}", sheet_list(.available))]
    UnknownSheet {
        requested: String,
        available: Vec<String>,
    },

    #[error("could not decode the table file: {0}")]
    Decode(String),
}

fn sheet_list(available: &[String]) -> String {
    if available.is_empty() {
        "this workbook has no sheets".to_string()
    } else {
        format!("this workbook has: {}", available.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_sheet_lists_the_available_names() {
        let err = TableError::UnknownSheet {
            requested: "Q5".to_string(),
            available: vec!["Q1".to_string(), "Q2".to_string(), "Q3".to_string()],
        };
        assert_eq!(
            err.to_string(),
            "unknown sheet \"Q5\"; this workbook has: Q1, Q2, Q3"
        );
    }

    #[test]
    fn unknown_sheet_survives_an_empty_workbook() {
        let err = TableError::UnknownSheet {
            requested: "Q5".to_string(),
            available: Vec::new(),
        };
        assert_eq!(
            err.to_string(),
            "unknown sheet \"Q5\"; this workbook has no sheets"
        );
    }

    #[test]
    fn unsupported_format_names_the_extension_and_the_alternatives() {
        let err = TableError::UnsupportedFormat {
            extension: "numbers".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "unsupported table format \"numbers\"; expected .csv, .tsv, .xlsx or .xlsm"
        );
    }
}
