use std::fs::File as StdFile;
use std::io::{Write};
use std::path::Path;
use walkdir::WalkDir;
use zip::write::FileOptions;

pub fn zip_directory(src_dir: &Path, dst_file: &Path) -> Result<(), String> {
    if !src_dir.exists() {
        return Err("Source directory does not exist".to_string());
    }

    let file = StdFile::create(dst_file).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);

    let walkdir = WalkDir::new(src_dir);
    let it = walkdir.into_iter();

    for entry in it {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        
        // Strip the parent directory path to preserve the root folder name inside the zip
        let parent = src_dir.parent().unwrap_or(src_dir);
        let name = path.strip_prefix(parent)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();

        if path.is_file() {
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            let mut f = StdFile::open(path).map_err(|e| e.to_string())?;
            let mut buffer = Vec::new();
            std::io::Read::read_to_end(&mut f, &mut buffer).map_err(|e| e.to_string())?;
            zip.write_all(&buffer).map_err(|e| e.to_string())?;
        } else if !name.is_empty() {
            zip.add_directory(name, options).map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn unzip_archive(src_file: &Path, dst_dir: &Path) -> Result<(), String> {
    let file = StdFile::open(src_file).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = match file.enclosed_name() {
            Some(path) => dst_dir.join(path),
            None => continue,
        };

        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
            }
            let mut outfile = StdFile::create(&outpath).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}
