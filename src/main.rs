use std::{
    net::{IpAddr, Ipv6Addr, SocketAddr},
    path::PathBuf,
};

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
    log_access_urls(address.port());
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

fn log_access_urls(port: u16) {
    match local_ip_addresses() {
        Ok(addresses) if addresses.is_empty() => {
            tracing::warn!(
                "no local network addresses were found; mDNS or localhost may still work"
            );
        }
        Ok(addresses) => {
            info!("local network access:");
            for ip in addresses {
                info!("  http://{}", SocketAddr::new(ip, port));
            }
        }
        Err(error) => {
            tracing::warn!("could not enumerate local network addresses: {error}");
        }
    }
}

fn local_ip_addresses() -> std::io::Result<Vec<IpAddr>> {
    let mut addresses = if_addrs::get_if_addrs()?
        .into_iter()
        .map(|interface| interface.ip())
        .filter(|address| is_connectable_address(*address))
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.dedup();
    Ok(addresses)
}

fn is_connectable_address(address: IpAddr) -> bool {
    if address.is_loopback() || address.is_unspecified() || address.is_multicast() {
        return false;
    }
    match address {
        IpAddr::V4(_) => true,
        IpAddr::V6(address) => !is_ipv6_link_local(address),
    }
}

fn is_ipv6_link_local(address: Ipv6Addr) -> bool {
    (address.segments()[0] & 0xffc0) == 0xfe80
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

    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    use super::{is_connectable_address, normalize_hostname, Cli};

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

    #[test]
    fn access_addresses_exclude_unusable_interfaces() {
        assert!(!is_connectable_address(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!is_connectable_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(!is_connectable_address(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!is_connectable_address(IpAddr::V6(
            "fe80::1".parse().unwrap()
        )));
        assert!(is_connectable_address(IpAddr::V4(
            "192.168.1.25".parse().unwrap()
        )));
        assert!(is_connectable_address(IpAddr::V6(
            "2001:db8::25".parse().unwrap()
        )));
    }

    #[test]
    fn ipv6_access_urls_are_bracketed() {
        assert_eq!(
            format!(
                "http://{}",
                SocketAddr::new("2001:db8::25".parse().unwrap(), 7777)
            ),
            "http://[2001:db8::25]:7777"
        );
    }
}
