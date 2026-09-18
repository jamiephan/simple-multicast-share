use std::io::{Cursor, Read};

use flate2::read::GzDecoder;
use serde::Serialize;

use crate::error::{ApiError, ApiResult};

const MAX_ARCHIVE_BYTES: usize = 100 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_RATIO: u64 = 200;

#[derive(Debug, Serialize)]
pub struct ArchiveListing {
    pub format: &'static str,
    pub entries: Vec<ArchiveEntry>,
    pub total_uncompressed_size: u64,
}

#[derive(Debug, Serialize)]
pub struct ArchiveEntry {
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compressed_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

pub fn list(name: &str, bytes: Vec<u8>) -> ApiResult<ArchiveListing> {
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(ApiError::PayloadTooLarge(
            "archives larger than 100 MiB cannot be inspected".into(),
        ));
    }
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".zip")
        || [
            ".docx", ".docm", ".xlsx", ".xlsm", ".xlsb", ".pptx", ".pptm", ".ppsx", ".ppsm",
            ".potx", ".potm", ".ods",
        ]
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        list_zip(bytes)
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        let compressed_len = bytes.len() as u64;
        list_tar(
            GzDecoder::new(Cursor::new(bytes)),
            "tar.gz",
            Some(compressed_len),
        )
    } else if lower.ends_with(".tar") {
        list_tar(Cursor::new(bytes), "tar", None)
    } else if lower.ends_with(".gz") {
        list_gzip(name, bytes)
    } else {
        Err(ApiError::Unsupported(
            "supported archive types are ZIP, TAR, TAR.GZ, TGZ, and GZ".into(),
        ))
    }
}

fn list_zip(bytes: Vec<u8>) -> ApiResult<ArchiveListing> {
    let compressed_len = bytes.len() as u64;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| ApiError::BadRequest(format!("invalid ZIP archive: {error}")))?;
    if archive.len() > MAX_ENTRIES {
        return Err(ApiError::PayloadTooLarge(
            "archive contains too many entries".into(),
        ));
    }
    let mut entries = Vec::with_capacity(archive.len());
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| ApiError::BadRequest(format!("invalid ZIP entry: {error}")))?;
        guard_entry(entry.size(), &mut total)?;
        let modified = entry.last_modified().filter(|value| value.is_valid());
        entries.push(ArchiveEntry {
            path: entry.name().chars().take(4096).collect(),
            kind: if entry.is_dir() { "folder" } else { "file" },
            size: entry.size(),
            compressed_size: Some(entry.compressed_size()),
            modified: modified.map(|value| {
                format!(
                    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
                    value.year(),
                    value.month(),
                    value.day(),
                    value.hour(),
                    value.minute(),
                    value.second()
                )
            }),
        });
    }
    guard_ratio(total, compressed_len)?;
    Ok(ArchiveListing {
        format: "zip",
        entries,
        total_uncompressed_size: total,
    })
}

fn list_tar<R: Read>(
    reader: R,
    format: &'static str,
    compressed_len: Option<u64>,
) -> ApiResult<ArchiveListing> {
    let mut archive = tar::Archive::new(reader);
    let mut entries = Vec::new();
    let mut total = 0_u64;
    let source = archive
        .entries()
        .map_err(|error| ApiError::BadRequest(format!("invalid TAR archive: {error}")))?;
    for entry in source {
        if entries.len() >= MAX_ENTRIES {
            return Err(ApiError::PayloadTooLarge(
                "archive contains too many entries".into(),
            ));
        }
        let entry =
            entry.map_err(|error| ApiError::BadRequest(format!("invalid TAR entry: {error}")))?;
        let size = entry.size();
        guard_entry(size, &mut total)?;
        let path = entry
            .path()
            .map_err(|error| ApiError::BadRequest(format!("invalid TAR path: {error}")))?
            .to_string_lossy()
            .chars()
            .take(4096)
            .collect();
        entries.push(ArchiveEntry {
            path,
            kind: if entry.header().entry_type().is_dir() {
                "folder"
            } else {
                "file"
            },
            size,
            compressed_size: None,
            modified: None,
        });
    }
    if let Some(compressed_len) = compressed_len {
        guard_ratio(total, compressed_len)?;
    }
    Ok(ArchiveListing {
        format,
        entries,
        total_uncompressed_size: total,
    })
}

fn list_gzip(name: &str, bytes: Vec<u8>) -> ApiResult<ArchiveListing> {
    let compressed_len = bytes.len() as u64;
    let mut decoder = GzDecoder::new(Cursor::new(bytes));
    let mut sink = std::io::sink();
    let size = std::io::copy(&mut decoder.by_ref().take(MAX_ENTRY_BYTES + 1), &mut sink)
        .map_err(|error| ApiError::BadRequest(format!("invalid GZ stream: {error}")))?;
    if size > MAX_ENTRY_BYTES {
        return Err(ApiError::PayloadTooLarge(
            "compressed entry is larger than 256 MiB".into(),
        ));
    }
    guard_ratio(size, compressed_len)?;
    let path = name
        .strip_suffix(".gz")
        .or_else(|| name.strip_suffix(".GZ"))
        .unwrap_or(name)
        .to_owned();
    Ok(ArchiveListing {
        format: "gz",
        total_uncompressed_size: size,
        entries: vec![ArchiveEntry {
            path,
            kind: "file",
            size,
            compressed_size: Some(compressed_len),
            modified: None,
        }],
    })
}

fn guard_entry(size: u64, total: &mut u64) -> ApiResult<()> {
    if size > MAX_ENTRY_BYTES {
        return Err(ApiError::PayloadTooLarge(
            "archive entry is larger than 256 MiB".into(),
        ));
    }
    *total = total
        .checked_add(size)
        .ok_or_else(|| ApiError::PayloadTooLarge("archive size overflow".into()))?;
    if *total > MAX_TOTAL_BYTES {
        return Err(ApiError::PayloadTooLarge(
            "archive expands beyond 1 GiB".into(),
        ));
    }
    Ok(())
}

fn guard_ratio(uncompressed: u64, compressed: u64) -> ApiResult<()> {
    if compressed > 0 && uncompressed / compressed > MAX_RATIO {
        return Err(ApiError::PayloadTooLarge(
            "archive compression ratio exceeds 200:1".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use flate2::{write::GzEncoder, Compression};
    use zip::{write::SimpleFileOptions, DateTime, ZipWriter};

    use super::list;

    #[test]
    fn lists_a_gzip_stream_without_extracting_it() {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(b"hello archive").unwrap();
        let bytes = encoder.finish().unwrap();

        let listing = list("note.txt.gz", bytes).unwrap();
        assert_eq!(listing.format, "gz");
        assert_eq!(listing.total_uncompressed_size, 13);
        assert_eq!(listing.entries[0].path, "note.txt");
    }

    #[test]
    fn lists_a_zip_entry_modified_time() {
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        let modified = DateTime::from_date_and_time(2026, 9, 19, 14, 30, 12).unwrap();
        let options = SimpleFileOptions::default().last_modified_time(modified);
        archive.start_file("notes/readme.md", options).unwrap();
        archive.write_all(b"hello archive").unwrap();
        let bytes = archive.finish().unwrap().into_inner();

        let listing = list("notes.zip", bytes).unwrap();
        assert_eq!(
            listing.entries[0].modified.as_deref(),
            Some("2026-09-19T14:30:12")
        );
    }

    #[test]
    fn rejects_unknown_archive_types() {
        assert!(list("file.7z", Vec::new()).is_err());
    }
}
