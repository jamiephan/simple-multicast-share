use std::{net::SocketAddr, path::PathBuf};

use clap::{ArgAction, Parser};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use simple_multicast_share::{app, AppState};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(version, about = "LAN file sharing server")]
struct Cli {
    #[arg(long, default_value_t = 7777)]
    port: u16,
    #[arg(long, action = ArgAction::SetTrue, default_value_t = true)]
    mdns: bool,
    #[arg(long = "no-mdns", action = ArgAction::SetTrue)]
    no_mdns: bool,
    #[arg(long)]
    db: Option<PathBuf>,
    #[arg(long)]
    hostname: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let cli = Cli::parse();
    let db_path = match cli.db {
        Some(path) => path,
        None => {
            let mut path = std::env::current_exe()?;
            path.set_extension("db");
            path
        }
    };
    let hostname = cli.hostname.unwrap_or_else(|| {
        hostname::get()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    let hostname = normalize_hostname(&hostname);
    let state = AppState::new(db_path.clone())?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cli.port)).await?;
    let address = listener.local_addr()?;

    let mdns = if cli.mdns && !cli.no_mdns {
        match advertise(&hostname, address.port()) {
            Ok(value) => {
                info!(
                    "advertising http://{}.local:{} via mDNS",
                    hostname,
                    address.port()
                );
                Some(value)
            }
            Err(error) => {
                tracing::warn!("mDNS advertisement failed: {error}");
                None
            }
        }
    } else {
        None
    };
    info!("listening on {address}; database {}", db_path.display());
    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    if let Some((daemon, fullname)) = mdns {
        let _ = daemon.unregister(&fullname);
        let _ = daemon.shutdown();
    }
    Ok(())
}

fn advertise(
    hostname: &str,
    port: u16,
) -> Result<(ServiceDaemon, String), Box<dyn std::error::Error>> {
    let daemon = ServiceDaemon::new()?;
    let service_type = "_http._tcp.local.";
    let host_name = format!("{hostname}.local.");
    let properties = [("path", "/")];
    let service = ServiceInfo::new(
        service_type,
        hostname,
        &host_name,
        "",
        port,
        &properties[..],
    )?
    .enable_addr_auto();
    let fullname = service.get_fullname().to_owned();
    daemon.register(service)?;
    Ok((daemon, fullname))
}

fn normalize_hostname(value: &str) -> String {
    let value = value.trim_end_matches(".local").trim_matches('.');
    let normalized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(63)
        .collect();
    let normalized = normalized.trim_matches('-');
    if normalized.is_empty() {
        "simple-multicast-share".into()
    } else {
        normalized.into()
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl+C signal handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM signal handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::{normalize_hostname, Cli};

    #[test]
    fn default_port_is_7777() {
        let cli = Cli::try_parse_from(["simple-multicast-share"]).expect("default CLI");
        assert_eq!(cli.port, 7777);
    }

    #[test]
    fn hostname_is_dns_safe() {
        assert_eq!(normalize_hostname("My Laptop.local"), "my-laptop");
        assert_eq!(normalize_hostname("..."), "simple-multicast-share");
    }
}
