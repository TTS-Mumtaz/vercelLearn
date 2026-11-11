//! Route bundle stats of production builds (`diagnostics/route-bundle-stats.json`).
//!
//! For every page route of both routers, lists the client JS chunks loaded on first load and
//! their total uncompressed size, sorted by size (largest first), then by route.
//!
//! The stats depend on the outputs of every endpoint. They are computed after all output assets
//! have been emitted, in a separate strongly consistent operation. The work is split into small
//! tasks (per batch of routes, per route, per chunk) so that no single task depends on a large
//! number of other tasks.

use anyhow::{Context, Result};
use bincode::{Decode, Encode};
use next_core::next_manifests::route_bundle_stats::app_page_first_load_js_chunks;
use serde::Serialize;
use turbo_rcstr::RcStr;
use turbo_tasks::{FxIndexMap, ResolvedVc, TryJoinIterExt, Vc};
use turbo_tasks_fs::{FileContent, FileSystem, FileSystemPath};
use turbopack_core::{
    asset::{Asset, AssetContent},
    output::OutputAsset,
};

use crate::{
    project::Project,
    route::{Endpoint, FirstLoadJs, Route},
};

/// Routes are processed in batches of this size, to keep the number of children per task small.
const BATCH_SIZE: usize = 64;

/// A client JS chunk: its path relative to the client root and its uncompressed size.
#[turbo_tasks::value(shared)]
struct ChunkStat {
    path: RcStr,
    size: u64,
}

#[turbo_tasks::value(transparent)]
struct ChunkStats(Vec<ChunkStat>);

/// The client JS chunks loaded on the first load of a page endpoint, or `None` if the endpoint
/// doesn't render a page.
#[turbo_tasks::value(transparent)]
struct OptionChunkStats(Option<ResolvedVc<ChunkStats>>);

/// The uncompressed size of an emitted asset.
#[turbo_tasks::function]
async fn asset_size(asset: ResolvedVc<Box<dyn OutputAsset>>) -> Result<Vc<u64>> {
    Ok(Vc::cell(match &*asset.content().await? {
        AssetContent::File(content) => match &*content.await? {
            FileContent::Content(file) => file.content().len() as u64,
            FileContent::NotFound => 0,
        },
        AssetContent::Redirect { .. } => 0,
    }))
}

/// The first load JS chunks of an endpoint (`.js` files only, each once, in load order).
#[turbo_tasks::function]
async fn endpoint_first_load_js(
    endpoint: ResolvedVc<Box<dyn Endpoint>>,
    client_relative_path: FileSystemPath,
    generate_component_chunks: bool,
) -> Result<Vc<OptionChunkStats>> {
    let output = endpoint.output().await?;
    let chunks: Vec<(RcStr, ResolvedVc<Box<dyn OutputAsset>>)> = match &output.first_load_js {
        None => return Ok(Vc::cell(None)),
        Some(FirstLoadJs::AppPage {
            client_references,
            client_references_chunks,
            client_shared_chunks,
        }) => {
            app_page_first_load_js_chunks(
                *client_references,
                *client_references_chunks,
                *client_shared_chunks,
                &client_relative_path,
                generate_component_chunks,
            )
            .await?
        }
        Some(FirstLoadJs::PagesPage(chunks)) => {
            let chunks = chunks.await?;
            let paths = chunks.iter().map(|chunk| chunk.path()).try_join().await?;
            chunks
                .iter()
                .zip(paths.iter())
                .filter_map(|(&chunk, path)| {
                    let path = client_relative_path.get_path_to(path)?;
                    path.ends_with(".js").then(|| (RcStr::from(path), chunk))
                })
                .collect()
        }
    };
    let sizes = chunks
        .iter()
        .map(|(_, chunk)| asset_size(**chunk))
        .try_join()
        .await?;
    let stats = chunks
        .into_iter()
        .zip(sizes)
        .map(|((path, _), size)| ChunkStat { path, size: *size })
        .collect();
    Ok(Vc::cell(Some(ChunkStats(stats).resolved_cell())))
}

/// A route of the stats: its endpoints (the first one that renders a page is used), and whether
/// it is a Pages Router route (which also loads the `/_app` chunks).
#[turbo_tasks::task_input]
#[derive(Clone, Debug, PartialEq, Eq, Hash, Encode, Decode)]
struct StatsRoute {
    route: RcStr,
    endpoints: Vec<ResolvedVc<Box<dyn Endpoint>>>,
    is_pages: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[turbo_tasks::value(shared)]
struct RouteBundleStat {
    route: RcStr,
    first_load_uncompressed_js_bytes: u64,
    /// Relative to the project directory, with the platform's path separator.
    first_load_chunk_paths: Vec<RcStr>,
}

#[turbo_tasks::value(transparent)]
struct RouteBundleStats(Vec<RouteBundleStat>);

/// Computes the rows of a batch of routes.
#[turbo_tasks::function]
async fn route_bundle_stats_batch(
    routes: Vec<StatsRoute>,
    app_endpoint: Option<ResolvedVc<Box<dyn Endpoint>>>,
    client_relative_path: FileSystemPath,
    generate_component_chunks: bool,
    dist_dir: RcStr,
) -> Result<Vc<RouteBundleStats>> {
    let first_load_js = async |endpoint| {
        anyhow::Ok(
            match *endpoint_first_load_js(
                endpoint,
                client_relative_path.clone(),
                generate_component_chunks,
            )
            .await?
            {
                Some(stats) => Some(stats.await?),
                None => None,
            },
        )
    };
    let app_chunks = match app_endpoint {
        Some(endpoint) if routes.iter().any(|route| route.is_pages) => {
            first_load_js(*endpoint).await?
        }
        _ => None,
    };
    let rows = routes
        .iter()
        .map(async |route| {
            let mut own_chunks = None;
            for &endpoint in &route.endpoints {
                own_chunks = first_load_js(*endpoint).await?;
                if own_chunks.is_some() {
                    break;
                }
            }
            if own_chunks.is_none() && !route.is_pages {
                return Ok(None);
            }
            let shared_chunks = if route.is_pages {
                app_chunks.as_ref()
            } else {
                None
            };
            // Chunks are identified by their path in the stats, so dedupe by path.
            let mut chunks: FxIndexMap<&RcStr, u64> = FxIndexMap::default();
            for stat in own_chunks
                .iter()
                .chain(shared_chunks)
                .flat_map(|stats| stats.iter())
            {
                chunks.entry(&stat.path).or_insert(stat.size);
            }
            anyhow::Ok(Some(RouteBundleStat {
                route: route.route.clone(),
                first_load_uncompressed_js_bytes: chunks.values().sum(),
                first_load_chunk_paths: chunks
                    .into_keys()
                    .map(|path| project_relative_chunk_path(&dist_dir, path))
                    .collect(),
            }))
        })
        .try_join()
        .await?;
    Ok(Vc::cell(rows.into_iter().flatten().collect()))
}

/// The route bundle stats file of a production build.
#[turbo_tasks::value(shared)]
pub struct RouteBundleStatsFile {
    pub path: FileSystemPath,
    pub content: RcStr,
}

#[turbo_tasks::value(transparent)]
pub struct OptionRouteBundleStatsFile(Option<RouteBundleStatsFile>);

/// Returns the route bundle stats file for production builds, `None` otherwise.
///
/// Meant to be called from an operation after all output assets have been emitted, not as one of
/// the output assets.
#[turbo_tasks::function]
pub async fn route_bundle_stats_file(
    project: ResolvedVc<Project>,
    app_dir_only: bool,
) -> Result<Vc<OptionRouteBundleStatsFile>> {
    if !project.next_mode().await?.is_production() {
        return Ok(Vc::cell(None));
    }
    let entrypoints = project.entrypoints().await?;
    let client_relative_path = project.client_relative_path().owned().await?;
    let generate_component_chunks = *project
        .next_config()
        .turbopack_generate_component_chunks()
        .await?;
    let node_root = project.node_root().owned().await?;
    let project_dir = project
        .output_fs()
        .root()
        .await?
        .join(&project.project_path().await?.path)?;
    let dist_dir = project_dir
        .get_relative_path_to(&node_root)
        .context("the dist dir must be on the output file system")?;

    let mut routes = Vec::new();
    for (pathname, route) in entrypoints.routes.iter() {
        let (endpoints, is_pages) = match route {
            Route::Page { .. } | Route::PageApi { .. }
                if app_dir_only
                    || matches!(pathname.as_str(), "/_app" | "/_document" | "/_error") =>
            {
                continue;
            }
            Route::Page { html_endpoint, .. } => (vec![*html_endpoint], true),
            // API routes only load the `/_app` chunks.
            Route::PageApi { .. } => (vec![], true),
            Route::AppPage(_) if matches!(pathname.as_str(), "/favicon.ico" | "/_global-error") => {
                continue;
            }
            Route::AppPage(pages) => (pages.iter().map(|page| page.html_endpoint).collect(), false),
            Route::AppRoute { .. } | Route::AppGoRoute { .. } | Route::Conflict => continue,
        };
        routes.push(StatsRoute {
            route: pathname.clone(),
            endpoints,
            is_pages,
        });
    }

    let batches = routes
        .chunks(BATCH_SIZE)
        .map(|batch| {
            route_bundle_stats_batch(
                batch.to_vec(),
                Some(*entrypoints.pages_app_endpoint),
                client_relative_path.clone(),
                generate_component_chunks,
                dist_dir.clone(),
            )
        })
        .try_join()
        .await?;
    let mut rows = batches
        .iter()
        .flat_map(|batch| batch.iter())
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        b.first_load_uncompressed_js_bytes
            .cmp(&a.first_load_uncompressed_js_bytes)
            .then_with(|| a.route.cmp(&b.route))
    });

    Ok(Vc::cell(Some(RouteBundleStatsFile {
        path: node_root.join("diagnostics/route-bundle-stats.json")?,
        content: serde_json::to_string_pretty(&rows)?.into(),
    })))
}

/// The path of a chunk relative to the project directory, using the platform's path separator
/// (like Node.js's `path.relative`).
fn project_relative_chunk_path(dist_dir: &str, client_relative_path: &str) -> RcStr {
    let path = if dist_dir.is_empty() || dist_dir == "." {
        client_relative_path.to_string()
    } else {
        format!("{dist_dir}/{client_relative_path}")
    };
    if std::path::MAIN_SEPARATOR == '/' {
        path.into()
    } else {
        path.replace('/', std::path::MAIN_SEPARATOR_STR).into()
    }
}
