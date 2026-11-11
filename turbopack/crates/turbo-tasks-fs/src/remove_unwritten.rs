//! Removal of the entries of an output directory that were not written in the current session.
//! See [`DiskFileSystem::remove_entries_not_written_in_session`].

use std::{
    fs::FileType,
    io::{self, ErrorKind},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use anyhow::{Context, Result};
use futures::future::try_join_all;
use rustc_hash::FxHashSet;
use turbo_rcstr::RcStr;

use crate::{DiskFileSystem, retry::retry_blocking};

/// Options for [`DiskFileSystem::remove_entries_not_written_in_session`].
#[derive(Debug, Default, Clone)]
pub struct RemoveUnwrittenOptions {
    /// Paths relative to the directory, using `/` as separator, whose entries (and their
    /// contents, for directories) are left untouched and are not traversed.
    pub skip: FxHashSet<RcStr>,
    /// Paths relative to the directory, using `/` as separator, of entries that are kept even
    /// though they were not written by this filesystem in the current session, e.g. because they
    /// were written by another process. Kept directories are still traversed, but are not removed
    /// when they end up empty.
    pub keep: FxHashSet<RcStr>,
}

/// Statistics of [`DiskFileSystem::remove_entries_not_written_in_session`].
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RemoveUnwrittenStats {
    /// Number of removed files and symlinks.
    pub removed_files: usize,
    /// Number of removed directories.
    pub removed_directories: usize,
}

struct SweepState {
    fs: DiskFileSystem,
    options: RemoveUnwrittenOptions,
    removed_files: AtomicUsize,
    removed_directories: AtomicUsize,
}

pub(crate) async fn remove_entries_not_written_in_session(
    fs: DiskFileSystem,
    dir: PathBuf,
    options: RemoveUnwrittenOptions,
) -> Result<RemoveUnwrittenStats> {
    let ctx = Arc::new(SweepState {
        fs,
        options,
        removed_files: AtomicUsize::new(0),
        removed_directories: AtomicUsize::new(0),
    });
    // The root directory itself is never removed.
    sweep_dir(ctx.clone(), dir, RcStr::default()).await?;
    Ok(RemoveUnwrittenStats {
        removed_files: ctx.removed_files.load(Ordering::Relaxed),
        removed_directories: ctx.removed_directories.load(Ordering::Relaxed),
    })
}

/// Sweeps `dir` (with the relative path `relative`) and returns whether it is empty afterwards.
///
/// Subdirectories are swept in parallel on separate tasks. File system operations are blocking,
/// but short, like elsewhere in this crate.
async fn sweep_dir(ctx: Arc<SweepState>, dir: PathBuf, relative: RcStr) -> Result<bool> {
    let entries = match read_dir(&dir).await {
        Ok(entries) => entries,
        // The directory may have been removed concurrently, which is fine.
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(true),
        Err(err) => return Err(err).with_context(|| format!("reading directory {dir:?} failed")),
    };

    let mut is_empty = true;
    let mut subdirectories = Vec::new();
    for (name, file_type) in entries {
        let path = dir.join(&name);
        let relative = if relative.is_empty() {
            RcStr::from(name)
        } else {
            RcStr::from(format!("{relative}/{name}"))
        };
        if ctx.options.skip.contains(&relative) {
            is_empty = false;
            continue;
        }
        // `file_type` comes from `read_dir`, so it doesn't follow symlinks: links are removed, not
        // their targets.
        if file_type.is_dir() {
            let kept = ctx.options.keep.contains(&relative);
            subdirectories.push(tokio::spawn({
                let ctx = ctx.clone();
                async move {
                    let child_is_empty = sweep_dir(ctx.clone(), path.clone(), relative).await?;
                    if !child_is_empty || kept {
                        return Ok::<_, anyhow::Error>(false);
                    }
                    remove(&path, true).await?;
                    ctx.removed_directories.fetch_add(1, Ordering::Relaxed);
                    Ok(true)
                }
            }));
        } else if ctx.options.keep.contains(&relative) || ctx.fs.was_written_in_session(&path) {
            is_empty = false;
        } else {
            remove(&path, is_dir_link(&path, file_type)).await?;
            ctx.removed_files.fetch_add(1, Ordering::Relaxed);
        }
    }

    for removed in try_join_all(subdirectories).await? {
        if !removed? {
            is_empty = false;
        }
    }
    Ok(is_empty)
}

async fn read_dir(dir: &Path) -> io::Result<Vec<(String, FileType)>> {
    retry_blocking(|| {
        std::fs::read_dir(dir)?
            .map(|entry| {
                let entry = entry?;
                let name = entry.file_name().into_string().map_err(|name| {
                    io::Error::new(
                        ErrorKind::InvalidData,
                        format!("file name {name:?} is not valid unicode"),
                    )
                })?;
                Ok((name, entry.file_type()?))
            })
            .collect()
    })
    .await
}

/// Directory symlinks and junction points need to be removed with `remove_dir` on Windows.
#[cfg(windows)]
fn is_dir_link(path: &Path, file_type: FileType) -> bool {
    use std::os::windows::fs::FileTypeExt;
    file_type.is_symlink_dir()
        || (file_type.is_symlink() && crate::windows::is_link_junction_point(path).unwrap_or(false))
}

#[cfg(not(windows))]
fn is_dir_link(_path: &Path, _file_type: FileType) -> bool {
    false
}

async fn remove(path: &Path, is_dir: bool) -> Result<()> {
    retry_blocking(|| {
        if is_dir {
            std::fs::remove_dir(path)
        } else {
            std::fs::remove_file(path)
        }
    })
    .await
    .or_else(|err| {
        if err.kind() == ErrorKind::NotFound {
            Ok(())
        } else {
            Err(err)
        }
    })
    .with_context(|| format!("removing {path:?} failed"))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use rustc_hash::FxHashSet;
    use turbo_rcstr::{RcStr, rcstr};
    use turbo_tasks::{Effects, Vc, read_strongly_consistent_and_apply_effects, take_effects};
    use turbo_tasks_backend::{BackendOptions, TurboTasksBackend, noop_backing_storage};

    use crate::{
        DiskFileSystem, DiskFileSystemMap, DiskWatcherConfig, File, FileContent, FileSystem,
        FileSystemPath, RemoveUnwrittenOptions, RemoveUnwrittenStats,
    };

    /// A turbo-tasks function, so that all callers share the same filesystem instance.
    #[turbo_tasks::function]
    fn test_fs(root: RcStr) -> Vc<DiskFileSystem> {
        DiskFileSystem::new_with_options(
            rcstr!("test"),
            Vc::cell(root),
            Vec::new(),
            DiskWatcherConfig::default(),
            DiskFileSystemMap::empty(),
        )
    }

    #[turbo_tasks::function(operation, root)]
    async fn write_outputs_operation(root: RcStr) -> anyhow::Result<()> {
        let out = test_fs(root).root().await?.join("out")?;
        let write = |path: &str, content: &str| -> anyhow::Result<Vc<()>> {
            let content = if content.is_empty() {
                FileContent::NotFound
            } else {
                FileContent::Content(File::from_bytes(content.as_bytes().to_vec()))
            };
            Ok(out.join(path)?.write(content.cell()))
        };
        // a new file in an existing directory
        write("server/new.js", "new")?.await?;
        // a file that already exists with the same content: the write is skipped
        write("server/unchanged.js", "unchanged")?.await?;
        // a file in a new directory
        write("static/chunks/a.js", "a")?.await?;
        // a file that is removed
        write("server/removed.js", "")?.await?;
        Ok(())
    }

    #[turbo_tasks::function(operation, root)]
    async fn write_outputs_effects_operation(root: RcStr) -> anyhow::Result<Vc<Effects>> {
        let op = write_outputs_operation(root);
        op.read_strongly_consistent().await?;
        Ok(take_effects(op).await?.cell())
    }

    #[turbo_tasks::function(operation, root)]
    fn test_fs_operation(root: RcStr) -> Vc<DiskFileSystem> {
        test_fs(root)
    }

    #[turbo_tasks::function(operation, root)]
    async fn out_dir_operation(root: RcStr) -> anyhow::Result<Vc<FileSystemPath>> {
        Ok(test_fs(root).root().await?.join("out")?.cell())
    }

    fn write_file(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn list(dir: &Path, prefix: &str, result: &mut Vec<String>) {
        let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = format!("{prefix}{}", entry.file_name().to_str().unwrap());
            if entry.file_type().unwrap().is_dir() {
                result.push(format!("{name}/"));
                list(&entry.path(), &format!("{name}/"), result);
            } else {
                result.push(name);
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn removes_entries_not_written_in_session() {
        let scratch = tempfile::tempdir().unwrap();
        let root_path = scratch.path();
        let out = root_path.join("out");
        // Output of a previous session
        write_file(&out.join("server/unchanged.js"), "unchanged");
        write_file(&out.join("server/removed.js"), "removed");
        write_file(&out.join("server/stale.js"), "stale");
        write_file(&out.join("server/stale-dir/nested/stale.js"), "stale");
        write_file(&out.join("stale-top-level.json"), "stale");
        fs::create_dir_all(out.join("stale-empty-dir")).unwrap();
        // Written by someone else during this session
        write_file(&out.join("external.json"), "external");
        fs::create_dir_all(out.join("external-empty-dir")).unwrap();
        // Skipped entirely
        write_file(&out.join("cache/data"), "cache");
        // A symlink to a directory outside of the output, which must not be followed
        let outside = root_path.join("outside");
        write_file(&outside.join("keep.txt"), "keep");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, out.join("server/link")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::junction_point(&outside, out.join("server/link")).unwrap();

        let root = RcStr::from(root_path.to_str().unwrap());
        let unchanged_mtime = fs::metadata(out.join("server/unchanged.js"))
            .unwrap()
            .modified()
            .unwrap();
        let tt = turbo_tasks::TurboTasks::new(TurboTasksBackend::new(
            BackendOptions::default(),
            noop_backing_storage(),
        ));
        let stats = tt
            .run_once(async move {
                read_strongly_consistent_and_apply_effects(
                    write_outputs_effects_operation(root.clone()),
                    |e| e,
                )
                .await?;
                let fs = test_fs_operation(root.clone())
                    .read_strongly_consistent()
                    .await?;
                let out = out_dir_operation(root).read_strongly_consistent().await?;
                let out_sys = fs.to_sys_path_raw(&out);
                assert!(fs.was_written_in_session(&out_sys.join("server/new.js")));
                assert!(fs.was_written_in_session(&out_sys.join("server/unchanged.js")));
                assert!(!fs.was_written_in_session(&out_sys.join("server/removed.js")));
                assert!(!fs.was_written_in_session(&out_sys.join("server/stale.js")));
                let stats = fs
                    .remove_entries_not_written_in_session(
                        &out,
                        RemoveUnwrittenOptions {
                            skip: FxHashSet::from_iter([rcstr!("cache")]),
                            keep: FxHashSet::from_iter([
                                rcstr!("external.json"),
                                rcstr!("external-empty-dir"),
                            ]),
                        },
                    )
                    .await?;
                anyhow::Ok(stats)
            })
            .await
            .unwrap();

        let mut entries = Vec::new();
        list(&out, "", &mut entries);
        assert_eq!(
            entries,
            vec![
                "cache/",
                "cache/data",
                "external-empty-dir/",
                "external.json",
                "server/",
                "server/new.js",
                "server/unchanged.js",
                "static/",
                "static/chunks/",
                "static/chunks/a.js",
            ]
        );
        assert_eq!(
            stats,
            RemoveUnwrittenStats {
                // stale.js, stale-dir/nested/stale.js, stale-top-level.json, link
                removed_files: 4,
                // stale-dir/nested, stale-dir, stale-empty-dir
                removed_directories: 3,
            }
        );
        assert_eq!(
            fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "keep"
        );
        // The unchanged file was not rewritten, but still counts as written.
        assert_eq!(
            fs::metadata(out.join("server/unchanged.js"))
                .unwrap()
                .modified()
                .unwrap(),
            unchanged_mtime
        );
    }
}
