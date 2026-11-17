//! FTP/explicit-FTPS adapter. Credentials never leave the connection worker.
use crate::{
    attempt::{self, Attempt},
    model::*,
    remote_path, sorted, timestamp, validate_argument,
};
use std::{net::TcpStream, sync::Arc, time::SystemTime};
use suppaftp::{
    list::ListParser, native_tls::TlsConnector, types::FileType, FtpError, NativeTlsConnector,
    NativeTlsFtpStream,
};

pub(crate) fn connect(
    input: &ConnectionInput,
    attempt: &Arc<Attempt>,
) -> Result<NativeTlsFtpStream, String> {
    let timeout = input.timeout()?;
    let tcp = attempt::connect(&input.host, input.port, timeout, attempt)?;
    let mut ftp = NativeTlsFtpStream::connect_with_stream(tcp)
        .map_err(|e| format!("FTP handshake failed: {e}"))?;
    ftp = ftp.passive_stream_builder(move |address| {
        let stream =
            TcpStream::connect_timeout(&address, timeout).map_err(FtpError::ConnectionError)?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(FtpError::ConnectionError)?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(FtpError::ConnectionError)?;
        Ok(stream)
    });
    ftp.set_passive_nat_workaround(true);
    if input.protocol() == Protocol::Ftps {
        let connector =
            TlsConnector::new().map_err(|e| format!("TLS initialization failed: {e}"))?;
        ftp = ftp
            .into_secure(NativeTlsConnector::from(connector), &input.host)
            .map_err(|e| format!("Secure connection failed: {e}"))?;
    }
    attempt.check()?;
    ftp.login(&input.username, &input.password)
        .map_err(|_| "Login failed. Check your credentials and server permissions.".to_string())?;
    ftp.transfer_type(FileType::Binary)
        .map_err(|e| format!("Cannot select binary transfer mode: {e}"))?;
    attempt.check()?;
    Ok(ftp)
}
fn command_unsupported(error: &FtpError) -> bool {
    matches!(error, FtpError::UnexpectedResponse(response) if matches!(response.status as u32, 202 | 500 | 501 | 502 | 504))
}

pub(crate) fn listing(ftp: &mut NativeTlsFtpStream, path: &str) -> Result<Vec<FileEntry>, String> {
    validate_argument(path)?;
    let (lines, machine) = match ftp.mlsd(Some(path)) {
        Ok(lines) => (lines, true),
        Err(error) if command_unsupported(&error) => (
            ftp.list(Some(path))
                .map_err(|e| format!("Cannot list remote folder: {e}"))?,
            false,
        ),
        Err(error) => return Err(format!("Cannot list remote folder: {error}")),
    };
    let mut entries = Vec::new();
    for line in lines {
        let file = if machine {
            ListParser::parse_mlsd(&line)
        } else {
            ListParser::parse_posix(&line).or_else(|_| ListParser::parse_dos(&line))
        }
        .map_err(|_| "The server returned an unsupported directory listing.".to_string())?;
        if file.name() == "." || file.name() == ".." {
            continue;
        }
        validate_argument(file.name())?;
        if file.name().is_empty() || file.name().contains(['/', '\\']) {
            return Err("The server returned an invalid entry name.".into());
        }
        entries.push(FileEntry {
            name: file.name().to_owned(),
            path: remote_path(path, file.name()),
            is_directory: file.is_directory(),
            size: if file.is_directory() {
                0
            } else {
                file.size() as u64
            },
            // The parser uses UNIX_EPOCH when the server supplied no timestamp.
            modified: (file.modified() != SystemTime::UNIX_EPOCH)
                .then(|| timestamp(file.modified())),
        });
    }
    Ok(sorted(entries))
}
